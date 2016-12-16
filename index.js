/* jshint loopfunc: true, evil: true */
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var traverse = require('traverse');
var Session = require('msgpack5rpc');
var _ = require('lodash');

function Nvim(session, channel_id) {
  this._session = session;
  this._decode = decode;
  this._channel_id = channel_id;
}
util.inherits(Nvim, EventEmitter);

function decode(obj) {
  traverse(obj).forEach(function(item) {
    if (item instanceof Session) {
      this.update(item, true);
    } else if (Buffer.isBuffer(item)) {
      try { this.update(item.toString('utf8')); } catch (e) {}
    }
  });

  return obj;
}

function generateWrappers(Nvim, types, metadata) {
  for (var i = 0; i < metadata.functions.length; i++) {
    var func = metadata.functions[i];
    var parts = func.name.split('_');
    var typeName = _.capitalize(parts[0]);
    // The type name is the word before the first dash capitalized. If the type
    // is Vim, then it a editor-global method which will be attached to the Nvim
    // class.
    var methodName = _.camelCase(parts.slice(typeName !== 'Ui').join('_'));
    var args = func.parameters.map(function(param) {
      return param[1];
    });
    var Type, callArgs;
    if (typeName === 'Nvim' || typeName === 'Vim' || typeName === 'Ui') {
      Type = Nvim;
      callArgs = args.join(', ');
    } else {
      Type = types[typeName];
      args = args.slice(1);
      // This is a method of one of the ext types, prepend "this" to the call
      // arguments.
      callArgs = ['this'].concat(args).join(', ');
    }
    var params = args.concat(['cb']).join(', ');
    var method = new Function(
      'return function ' + methodName + '(' + params + ') {' +
      '\n  if (!cb) {' +
      '\n    this._session.notify("' + func.name + '", [' + callArgs + ']);' +
      '\n    return;' +
      '\n  }' +
      '\n  var _this = this;' +
      '\n  this._session.request("' + func.name +
          '", [' + callArgs + '], function(err, res) {' +
      '\n     if (err) return cb(new Error(err[1]));' +
      '\n     cb(null, _this._decode(res));' +
      '\n   });' +
      '\n};'
    )();
    method.metadata = {
      name: methodName,
      deferred: func.deferred,
      returnType: func.return_type,
      parameters: args.concat(['cb']),
      parameterTypes: func.parameters.map(function(p) { return p[0]; }),
      canFail: func.can_fail,
    }
    if (typeName === 'Nvim') {
      method.metadata.parameterTypes.shift();
    }
    Type.prototype[methodName] = method;
  }
}

function addExtraNvimMethods(Nvim) {
  Nvim.prototype.quit = function quit() {
    this.command('qa!', []);
  };
}

module.exports = function attach(writer, reader, cb) {
  var session = new Session([]);
  var initSession = session;
  var nvim = new Nvim(session);

  var pendingRPCs = [];
  var queueRequests = function(method, args, resp) {
    if (method !== 'specs') {
      pendingRPCs.push({
        type: 'request',
        args: Array.prototype.slice.call(arguments)
      });
    } else {
      nvim.emit('request', decode(method), decode(args), resp);
    }
  }
  var queueNotifications = function(method, args) {
    pendingRPCs.push({
      type: 'notification',
      args: Array.prototype.slice.call(arguments)
    });
  }

  session.attach(writer, reader);

  cb(null, nvim);

  // register initial RPC handlers to queue non-specs requests until api is generated
  session.on('request', queueRequests);
  session.on('notification', queueNotifications);

  session.on('detach', function() {
    session.removeAllListeners('request');
    session.removeAllListeners('notification');
    nvim.emit('disconnect');
  });

  session.request('vim_get_api_info', [], function(err, res) {
    if (err) {
      return cb(err);
    }

    var channel_id = res[0];

    var metadata = decode(res[1]);
    var extTypes = [];
    var types = {};

    Object.keys(metadata.types).forEach(function(name) {
      // Generate a constructor function for each type in metadata.types
      var Type = new Function(
        'return function ' + name + '(session, data, decode) { ' +
        '\n  this._session = session;' + 
        '\n  this._data = data;' +
        '\n  this._decode = decode;' +
        '\n};'
      )();
      Type.prototype.equals = function equals(other) {
        try {
          return this._data.toString() === other._data.toString();
        } catch (e) {
          return false;
        }
      };

      // Collect the type information necessary for msgpack5 deserialization
      // when it encounters the corresponding ext code.
      extTypes.push({
        constructor: Type,
        code: metadata.types[name].id,
        decode: function(data) { return new Type(session, data, decode); },
        encode: function(obj) { return obj._data; }
      });

      types[name] = Type;
      Nvim.prototype[name] = Type;
    });

    generateWrappers(Nvim, types, metadata);
    addExtraNvimMethods(Nvim);
    session.addTypes(extTypes);

    // register the non-queueing handlers
    session.removeListener('request', queueRequests);
    session.on('request', function(method, args, resp) {
      nvim.emit('request', decode(method), decode(args), resp);
    });

    session.removeListener('notification', queueNotifications);
    session.on('notification', function(method, args) {
      nvim.emit('notification', decode(method), decode(args));
    });

    // dequeue any pending RPCs
    pendingRPCs.forEach(function(pending) {
      nvim.emit.apply(nvim, Array.prototype.concat(pending.type, pending.args));
    });
  });
};

// 'default' export for ES2015 or TypeScript environment.
module.exports.default = module.exports;
