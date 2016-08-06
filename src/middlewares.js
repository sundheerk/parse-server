import AppCache from './cache';
import log from './logging';

var Parse = require('parse/node').Parse;

var auth = require('./Auth');
var Config = require('./Config');
var ClientSDK = require('./ClientSDK');

// Checks that the request is authorized for this app and checks user
// auth too.
// The bodyparser should run before this middleware.
// Adds info to the request:
// req.config - the Config for this app
// req.auth - the Auth for this request
function handleParseHeaders(req, res, next) {
  var mountPathLength = req.originalUrl.length - req.url.length;
  var mountPath = req.originalUrl.slice(0, mountPathLength);
  var mount = req.protocol + '://' + req.get('host') + mountPath;

  var info = {
    appId: req.get('X-Parse-Application-Id'),
    sessionToken: req.get('X-Parse-Session-Token'),
    masterKey: req.get('X-Parse-Master-Key'),
    installationId: req.get('X-Parse-Installation-Id'),
    clientKey: req.get('X-Parse-Client-Key'),
    javascriptKey: req.get('X-Parse-Javascript-Key'),
    dotNetKey: req.get('X-Parse-Windows-Key'),
    restAPIKey: req.get('X-Parse-REST-API-Key'),
    clientVersion: req.get('X-Parse-Client-Version')
  };

  var basicAuth = httpAuth(req);

  if (basicAuth) {
    info.appId = basicAuth.appId
    info.masterKey = basicAuth.masterKey || info.masterKey;
    info.javascriptKey = basicAuth.javascriptKey || info.javascriptKey;
  }

  if (req.body) {
    // Unity SDK sends a _noBody key which needs to be removed.
    // Unclear at this point if action needs to be taken.
    delete req.body._noBody;
  }

  var fileViaJSON = false;

  if (!info.appId || !AppCache.get(info.appId)) {
    // See if we can find the app id on the body.
    if (req.body instanceof Buffer) {
      // The only chance to find the app id is if this is a file
      // upload that actually is a JSON body. So try to parse it.
      req.body = JSON.parse(req.body);
      fileViaJSON = true;
    }

    if (req.body) {
      delete req.body._RevocableSession;
    }

    if (req.body &&
      req.body._ApplicationId &&
      AppCache.get(req.body._ApplicationId) &&
      (!info.masterKey || AppCache.get(req.body._ApplicationId).masterKey === info.masterKey)
    ) {
      info.appId = req.body._ApplicationId;
      info.javascriptKey = req.body._JavaScriptKey || '';
      delete req.body._ApplicationId;
      delete req.body._JavaScriptKey;
      // TODO: test that the REST API formats generated by the other
      // SDKs are handled ok
      if (req.body._ClientVersion) {
        info.clientVersion = req.body._ClientVersion;
        delete req.body._ClientVersion;
      }
      if (req.body._InstallationId) {
        info.installationId = req.body._InstallationId;
        delete req.body._InstallationId;
      }
      if (req.body._SessionToken) {
        info.sessionToken = req.body._SessionToken;
        delete req.body._SessionToken;
      }
      if (req.body._MasterKey) {
        info.masterKey = req.body._MasterKey;
        delete req.body._MasterKey;
      }
      if (req.body._ContentType) {
        req.headers['content-type'] = req.body._ContentType;
        delete req.body._ContentType;
      }
    } else {
      return invalidRequest(req, res);
    }
  }

  if (info.clientVersion) {
    info.clientSDK = ClientSDK.fromString(info.clientVersion);
  }

  if (fileViaJSON) {
    // We need to repopulate req.body with a buffer
    var base64 = req.body.base64;
    req.body = new Buffer(base64, 'base64');
  }

  info.app = AppCache.get(info.appId);
  req.config = new Config(info.appId, mount);
  req.info = info;

  var isMaster = (info.masterKey === req.config.masterKey);

  if (isMaster) {
    req.auth = new auth.Auth({ config: req.config, installationId: info.installationId, isMaster: true });
    next();
    return;
  }

  // Client keys are not required in parse-server, but if any have been configured in the server, validate them
  //  to preserve original behavior.
  let keys = ["clientKey", "javascriptKey", "dotNetKey", "restAPIKey"];

  // We do it with mismatching keys to support no-keys config
  var keyMismatch = keys.reduce(function(mismatch, key){

    // check if set in the config and compare
    if (req.config[key] && info[key] !== req.config[key]) {
      mismatch++;
    }
    return mismatch;
  }, 0);

  // All keys mismatch
  if (keyMismatch == keys.length) {
    return invalidRequest(req, res);
  }

  if (req.url == "/login") {
    delete info.sessionToken;
  }

  if (!info.sessionToken) {
    req.auth = new auth.Auth({ config: req.config, installationId: info.installationId, isMaster: false });
    next();
    return;
  }

  return auth.getAuthForSessionToken({ config: req.config, installationId: info.installationId, sessionToken: info.sessionToken })
    .then((auth) => {
      if (auth) {
        req.auth = auth;
        next();
      }
    })
    .catch((error) => {
      if(error instanceof Parse.Error) {
        next(error);
        return;
      }
      else {
        // TODO: Determine the correct error scenario.
        log.logger.error('error getting auth for sessionToken', error);
        throw new Parse.Error(Parse.Error.UNKNOWN_ERROR, error);
      }
    });
}

function httpAuth(req) {
  if (!(req.req || req).headers.authorization)
    return ;

  var header = (req.req || req).headers.authorization;
  var appId, masterKey, javascriptKey;

  // parse header
  var authPrefix = 'basic ';

  var match = header.toLowerCase().indexOf(authPrefix);

  if (match == 0) {
    var encodedAuth = header.substring(authPrefix.length, header.length);
    var credentials = decodeBase64(encodedAuth).split(':');

    if (credentials.length == 2) {
      appId = credentials[0];
      var key = credentials[1];

      var jsKeyPrefix = 'javascript-key=';

      var matchKey = key.indexOf(jsKeyPrefix)
      if (matchKey == 0) {
        javascriptKey = key.substring(jsKeyPrefix.length, key.length);
      }
      else {
        masterKey = key;
      }
    }
  }

  return {appId: appId, masterKey: masterKey, javascriptKey: javascriptKey};
}

function decodeBase64(str) {
  return new Buffer(str, 'base64').toString()
}

var allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'X-Parse-Master-Key, X-Parse-REST-API-Key, X-Parse-Javascript-Key, X-Parse-Application-Id, X-Parse-Client-Version, X-Parse-Session-Token, X-Requested-With, X-Parse-Revocable-Session, Content-Type');

  // intercept OPTIONS method
  if ('OPTIONS' == req.method) {
    res.sendStatus(200);
  }
  else {
    next();
  }
};

var allowMethodOverride = function(req, res, next) {
  if (req.method === 'POST' && req.body._method) {
    req.originalMethod = req.method;
    req.method = req.body._method;
    delete req.body._method;
  }
  next();
};

var handleParseErrors = function(err, req, res, next) {
  // TODO: Add logging as those errors won't make it to the PromiseRouter
  if (err instanceof Parse.Error) {
    var httpStatus;

    // TODO: fill out this mapping
    switch (err.code) {
    case Parse.Error.INTERNAL_SERVER_ERROR:
      httpStatus = 500;
      break;
    case Parse.Error.OBJECT_NOT_FOUND:
      httpStatus = 404;
      break;
    default:
      httpStatus = 400;
    }

    res.status(httpStatus);
    res.json({code: err.code, error: err.message});
  } else if (err.status && err.message) {
    res.status(err.status);
    res.json({error: err.message});
  } else {
    log.logger.error('Uncaught internal server error.', err, err.stack);
    res.status(500);
    res.json({code: Parse.Error.INTERNAL_SERVER_ERROR,
              message: 'Internal server error.'});
  }
  next(err);
};

function enforceMasterKeyAccess(req, res, next) {
  if (!req.auth.isMaster) {
    res.status(403);
    res.end('{"error":"unauthorized: master key is required"}');
    return;
  }
  next();
}

function promiseEnforceMasterKeyAccess(request) {
  if (!request.auth.isMaster) {
    let error = new Error();
    error.status = 403;
    error.message = "unauthorized: master key is required";
    throw error;
  }
  return Promise.resolve();
}

function invalidRequest(req, res) {
  res.status(403);
  res.end('{"error":"unauthorized"}');
}

module.exports = {
  allowCrossDomain: allowCrossDomain,
  allowMethodOverride: allowMethodOverride,
  handleParseErrors: handleParseErrors,
  handleParseHeaders: handleParseHeaders,
  enforceMasterKeyAccess: enforceMasterKeyAccess,
  promiseEnforceMasterKeyAccess,
};
