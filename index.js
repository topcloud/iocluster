var EventEmitter = require('events').EventEmitter;
var ndata = require('ndata');
var async = require('async');
var ClientCluster = require('./clientcluster').ClientCluster;
var KeyManager = require('./keymanager').KeyManager;
var SCChannel = require('sc-channel').SCChannel;
var utils = require('./utils');
var isEmpty = utils.isEmpty;
var domain = require('domain');


var AbstractDataClient = function (dataClient) {
  this._dataClient = dataClient;
};

AbstractDataClient.prototype = Object.create(EventEmitter.prototype);

AbstractDataClient.prototype.set = function () {
  this._dataClient.set.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.expire = function () {
  this._dataClient.expire.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.unexpire = function () {
  this._dataClient.unexpire.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.add = function () {
  this._dataClient.add.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.get = function () {
  this._dataClient.get.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.getRange = function () {
  this._dataClient.getRange.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.getAll = function () {
  this._dataClient.getAll.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.count = function () {
  this._dataClient.count.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.remove = function () {
  this._dataClient.remove.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.removeRange = function () {
  this._dataClient.removeRange.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.removeAll = function () {
  this._dataClient.removeAll.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.splice = function () {
  this._dataClient.splice.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.pop = function () {
  this._dataClient.pop.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.hasKey = function () {
  this._dataClient.hasKey.apply(this._dataClient, arguments);
};

AbstractDataClient.prototype.stringify = function (value) {
  return this._dataClient.stringify(value);
};

AbstractDataClient.prototype.extractKeys = function (object) {
  return this._dataClient.extractKeys(object);
};

AbstractDataClient.prototype.extractValues = function (object) {
  return this._dataClient.extractValues(object);
};

/*
  run(queryFn,[ data, callback])
*/
AbstractDataClient.prototype.run = function () {
  var options = {};

  var callback;

  if (arguments[1] instanceof Function) {
    callback = arguments[1];
  } else {
    options.data = arguments[1];
    callback = arguments[2];
  }
  if (arguments[1] && !(arguments[1] instanceof Function)) {
    options.data = arguments[1];
  }
  this._dataClient.run(arguments[0], options, callback);
};


var Exchange = function (privateClientCluster, publicClientCluster, ioClusterClient) {
  AbstractDataClient.call(this, publicClientCluster);

  this._privateClientCluster = privateClientCluster;
  this._publicClientCluster = publicClientCluster;
  this._ioClusterClient = ioClusterClient;
  this._keyManager = new KeyManager();
  this._channelEmitter = new EventEmitter();
  this._channels = {};

  this._messageHander = this._handleChannelMessage.bind(this);

  this._ioClusterClient.on('message', this._messageHander);
};

Exchange.prototype = Object.create(AbstractDataClient.prototype);

Exchange.prototype.destroy = function () {
  this._ioClusterClient.removeListener('message', this._messageHander);
};

Exchange.prototype._handleChannelMessage = function (message) {
  var channelName = message.channel;
  if (this.isSubscribed(channelName)) {
    this._channelEmitter.emit(channelName, message.data);
  }
};

Exchange.prototype._triggerChannelSubscribe = function (channel) {
  var channelName = channel.name;

  channel.state = channel.SUBSCRIBED;

  channel.emit('subscribe', channelName);
  EventEmitter.prototype.emit.call(this, 'subscribe', channelName);
};

Exchange.prototype._triggerChannelSubscribeFail = function (err, channel) {
  var channelName = channel.name;

  channel.state = channel.UNSUBSCRIBED;

  channel.emit('subscribeFail', err, channelName);
  EventEmitter.prototype.emit.call(this, 'subscribeFail', err, channelName);
};

Exchange.prototype._triggerChannelUnsubscribe = function (channel, newState) {
  var channelName = channel.name;
  var oldState = channel.state;

  if (newState) {
    channel.state = newState;
  } else {
    channel.state = channel.UNSUBSCRIBED;
  }
  if (oldState == channel.SUBSCRIBED) {
    channel.emit('unsubscribe', channelName);
    EventEmitter.prototype.emit.call(this, 'unsubscribe', channelName);
  }
};

Exchange.prototype.send = function (data, mapIndex, callback) {
  if (mapIndex == null) {
    // Send to all brokers in cluster if mapIndex is not provided
    mapIndex = '*';
  }
  var targetClients = this._privateClientCluster.map({mapIndex: mapIndex}, 'send');
  var len = targetClients.length;
  var tasks = [];

  for (var i = 0; i < len; i++) {
    (function (client) {
      tasks.push(function (cb) {
        client.send(data, cb);
      });
    })(targetClients[i]);
  }
  async.parallel(tasks, callback);
};

Exchange.prototype.publish = function (channelName, data, callback) {
  this._ioClusterClient.publish(channelName, data, callback);
};

Exchange.prototype.subscribe = function (channelName) {
  var self = this;

  var channel = this._channels[channelName];

  if (!channel) {
    channel = new SCChannel(channelName, this);
    this._channels[channelName] = channel;
  }

  if (channel.state == channel.UNSUBSCRIBED) {
    channel.state = channel.PENDING;
    this._ioClusterClient.subscribe(channelName, function (err) {
      if (err) {
        self._triggerChannelSubscribeFail(err, channel);
      } else {
        self._triggerChannelSubscribe(channel);
      }
    });
  }
  return channel;
};

Exchange.prototype.unsubscribe = function (channelName) {
  var channel = this._channels[channelName];

  if (channel) {
    if (channel.state != channel.UNSUBSCRIBED) {

      this._triggerChannelUnsubscribe(channel);

      // The only case in which unsubscribe can fail is if the connection is closed or dies.
      // If that's the case, the server will automatically unsubscribe the client so
      // we don't need to check for failure since this operation can never really fail.

      this._ioClusterClient.unsubscribe(channelName);
    }
  }
};

Exchange.prototype.channel = function (channelName) {
  var currentChannel = this._channels[channelName];

  if (!currentChannel) {
    currentChannel = new SCChannel(channelName, this);
    this._channels[channelName] = currentChannel;
  }
  return currentChannel;
};

Exchange.prototype.destroyChannel = function (channelName) {
  var channel = this._channels[channelName];
  channel.unwatch();
  channel.unsubscribe();
  delete this._channels[channelName];
};

Exchange.prototype.subscriptions = function (includePending) {
  var subs = [];
  var channel, includeChannel;
  for (var channelName in this._channels) {
    if (this._channels.hasOwnProperty(channelName)) {
      channel = this._channels[channelName];

      if (includePending) {
        includeChannel = channel && (channel.state == channel.SUBSCRIBED ||
          channel.state == channel.PENDING);
      } else {
        includeChannel = channel && channel.state == channel.SUBSCRIBED;
      }

      if (includeChannel) {
        subs.push(channelName);
      }
    }
  }
  return subs;
};

Exchange.prototype.isSubscribed = function (channelName, includePending) {
  var channel = this._channels[channelName];
  if (includePending) {
    return !!channel && (channel.state == channel.SUBSCRIBED ||
      channel.state == channel.PENDING);
  }
  return !!channel && channel.state == channel.SUBSCRIBED;
};

Exchange.prototype.watch = function (channelName, handler) {
  this._channelEmitter.on(channelName, handler);
};

Exchange.prototype.unwatch = function (channelName, handler) {
  if (handler) {
    this._channelEmitter.removeListener(channelName, handler);
  } else {
    this._channelEmitter.removeAllListeners(channelName);
  }
};

Exchange.prototype.watchers = function (channelName) {
  return this._channelEmitter.listeners(channelName);
};

Exchange.prototype.setMapper = function (mapper) {
  this._publicClientCluster.setMapper(mapper);
};

Exchange.prototype.getMapper = function () {
  return this._publicClientCluster.getMapper();
};

Exchange.prototype.map = function () {
  return this._publicClientCluster.map.apply(this._publicClientCluster, arguments);
};


var IOCluster = module.exports.IOCluster = function (options) {
  var self = this;

  var dataServer;
  this._dataServers = [];

  var readyCount = 0;
  var len = options.brokers.length;
  var firstTime = true;
  var startDebugPort = options.debug;

  for (var i = 0; i < len; i++) {
    var launchServer = function (i) {
      var socketPath = options.brokers[i];

      dataServer = ndata.createServer({
        id: i,
        debug: startDebugPort ? startDebugPort + i : null,
        instanceId: options.instanceId,
        socketPath: socketPath,
        secretKey: options.secretKey,
        expiryAccuracy: options.expiryAccuracy,
        downgradeToUser: options.downgradeToUser,
        brokerControllerPath: options.appBrokerControllerPath,
        initControllerPath: options.appInitControllerPath,
        processTermTimeout: options.processTermTimeout,
        brokerOptions: options.brokerOptions
      });

      self._dataServers[i] = dataServer;

      if (firstTime) {
        dataServer.on('ready', function () {
          if (++readyCount >= options.brokers.length) {
            firstTime = false;
            self.emit('ready');
          }
        });
      }

      dataServer.on('error', function (err) {
        self.emit('error', err);
      });

      dataServer.on('exit', function () {
        self.emit('error', new Error('nData server at socket path ' + socketPath + ' exited'));
        launchServer(i);
      });

      dataServer.on('brokerMessage', function (brokerId, data) {
        self.emit('brokerMessage', brokerId, data);
      });
    };

    launchServer(i);
  }
};

IOCluster.prototype = Object.create(EventEmitter.prototype);

IOCluster.prototype.sendToBroker = function (brokerId, data) {
  var targetBroker = this._dataServers[brokerId];
  if (targetBroker) {
    targetBroker.sendMasterMessage(data);
  } else {
    var err = new Error('Broker with id ' + brokerId + ' does not exist');
    err.pid = process.pid;
    this.emit('error', err);
  }
};

IOCluster.prototype.destroy = function () {
  for (var i in this._dataServers) {
    if (this._dataServers.hasOwnProperty(i)) {
      this._dataServers[i].destroy();
    }
  }
};


var IOClusterClient = module.exports.IOClusterClient = function (options) {
  var self = this;

  this._errorDomain = domain.createDomain();
  this._errorDomain.on('error', function (err) {
    self.emit('error', err);
  });

  this._socketChannelLimit = options.socketChannelLimit;
  this.options = options;

  this._keyManager = new KeyManager();
  this._ready = false;

  var dataClient;
  var dataClients = [];

  for (var i in options.brokers) {
    if (options.brokers.hasOwnProperty(i)) {
      var socketPath = options.brokers[i];
      dataClient = ndata.createClient({
        socketPath: socketPath,
        secretKey: options.secretKey
      });
      dataClients.push(dataClient);
    }
  }

  var hasher = function (key) {
    var ch;
    var hash = 0;
    if (typeof key == 'number') {
      hash = key;
    } else {
      if (key instanceof Array) {
        key = key[0];
      }
      if (typeof key != 'string') {
        try {
          key = JSON.stringify(key);
        } catch (e) {
          key = null;
        }
      }
      if (key == null || key.length == 0) {
        return hash;
      }
      for (var i = 0; i < key.length; i++) {
        ch = key.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash = hash & hash;
      }
    }
    return Math.abs(hash) % dataClients.length;
  };

  var channelMethods = {
    publish: true,
    subscribe: true,
    unsubscribe: true,
    isSubscribed: true
  };

  this._defaultMapper = function (key, method, clientIds) {
    if (channelMethods[method]) {
      if (key == null) {
        return clientIds;
      }
      return hasher(key);
    } else if (method == 'query' || method == 'run' || method == 'send') {
      var mapIndex = key.mapIndex;
      if (mapIndex) {
        // A mapIndex of * means that the action should be sent to all
        // brokers in the cluster.
        if (mapIndex == '*') {
          return clientIds;
        } else {
          if (mapIndex instanceof Array) {
            var hashedIndexes = [];
            var len = mapIndex.length;
            for (var i = 0; i < len; i++) {
              hashedIndexes.push(hasher(mapIndex[i]));
            }
            return hashedIndexes;
          } else {
            return hasher(mapIndex);
          }
        }
      }
      return 0;
    } else if (method == 'removeAll') {
      return clientIds;
    }
    return hasher(key);
  };

  // The user cannot change the _defaultMapper for _privateClientCluster.
  this._privateClientCluster = new ClientCluster(dataClients);
  this._privateClientCluster.setMapper(this._defaultMapper);
  this._errorDomain.add(this._privateClientCluster);

  // The user can provide a custom mapper for _publicClientCluster.
  // The _defaultMapper is used by default.
  this._publicClientCluster = new ClientCluster(dataClients);
  this._publicClientCluster.setMapper(this._defaultMapper);
  this._errorDomain.add(this._publicClientCluster);

  this._sockets = {};

  this._exchangeSubscriptions = {};
  this._exchangeClient = new Exchange(this._privateClientCluster, this._publicClientCluster, this);

  this._clientSubscribers = {};

  var readyNum = 0;
  var firstTime = true;

  var dataClientReady = function () {
    if (++readyNum >= dataClients.length && firstTime) {
      firstTime = false;
      self._ready = true;
      self.emit('ready');
    }
  };

  for (var j in dataClients) {
    if (dataClients.hasOwnProperty(j)) {
      dataClients[j].on('ready', dataClientReady);
    }
  }

  this._privateClientCluster.on('message', this._handleExchangeMessage.bind(this));
};

IOClusterClient.prototype = Object.create(EventEmitter.prototype);

IOClusterClient.prototype.destroy = function (callback) {
  this._privateClientCluster.removeAll(callback);
};

IOClusterClient.prototype.on = function (event, listener) {
  if (event == 'ready' && this._ready) {
    listener();
  } else {
    EventEmitter.prototype.on.apply(this, arguments);
  }
};

IOClusterClient.prototype._validateSocket = function (socket, callback) {
  var self = this;

  if (socket.id == null) {
    callback && callback('Failed to validate - Socket did not have required id field');
  } else {
    callback && callback();
  }
};

// Add pub/sub functions to socket object
IOClusterClient.prototype._decorateSocket = function (socket) {
  var self = this;

  socket.channelSubscriptions = {};
  socket.channelSubscriptionCount = 0;

  // Decorate the socket with a kickOut method to allow us to kick it out
  // from a particular sub/sub channels at any time.
  socket.kickOut = function (channel, message, callback) {
    if (channel == null) {
      for (var i in socket.channelSubscriptions) {
        if (socket.channelSubscriptions.hasOwnProperty(i)) {
          socket.emit('#kickOut', {message: message, channel: i});
        }
      }
    } else {
      socket.emit('#kickOut', {message: message, channel: channel});
    }
    self.unsubscribeClientSocket(socket, channel, callback);
  };

  socket.subscriptions = function () {
    var subs = [];
    for (var i in socket.channelSubscriptions) {
      if (socket.channelSubscriptions.hasOwnProperty(i)) {
        subs.push(i);
      }
    }
    return subs;
  };

  socket.isSubscribed = function (channel) {
    return !!socket.channelSubscriptions[channel];
  };
};

IOClusterClient.prototype.bind = function (socket, callback) {
  var self = this;

  callback = this._errorDomain.bind(callback);

  this._decorateSocket(socket);

  this._validateSocket(socket, function (err) {
    if (err) {
      callback(err, socket, true);
    } else {
      self._sockets[socket.id] = socket;

      socket.on('#subscribe', function (channelOptions, res) {
        if (!channelOptions) {
          channelOptions = {};
        }
        self.subscribeClientSocket(socket, channelOptions.channel, function (err) {
          if (err) {
            res(err);
            self.emit('warning', err);
          } else {
            res();
          }
        });
      });

      socket.on('#unsubscribe', function (channel, res) {
        self.unsubscribeClientSocket(socket, channel, function (err, isWarning) {
          if (err) {
            res(err);

            if (isWarning) {
              self.emit('warning', err);
            } else {
              self.emit('error', err);
            }
          } else {
            res();
          }
        });
      });

      callback(null, socket);
    }
  });
};

IOClusterClient.prototype.unbind = function (socket, callback) {
  var self = this;

  callback = this._errorDomain.bind(callback);

  async.waterfall([
    function () {
      var cb = arguments[arguments.length - 1];
      socket.removeAllListeners('#subscribe');
      socket.removeAllListeners('#unsubscribe');
      self.unsubscribeClientSocket(socket, null, cb);
    },
    function () {
      var cb = arguments[arguments.length - 1];
      delete self._sockets[socket.id];
      cb();
    }
  ],
  function (err) {
    callback(err, socket);
  });
};

IOClusterClient.prototype.exchange = function () {
  return this._exchangeClient;
};

IOClusterClient.prototype._dropUnusedSubscriptions = function (channel, callback) {
  var self = this;

  if (isEmpty(this._clientSubscribers[channel])) {
    delete this._clientSubscribers[channel];
    if (!this._exchangeSubscriptions[channel]) {
      self._privateClientCluster.unsubscribe(channel, callback);
      return;
    }
  }
  callback && callback();
};

IOClusterClient.prototype.publish = function (channelName, data, callback) {
  this._privateClientCluster.publish(channelName, data, callback);
};

IOClusterClient.prototype.subscribe = function (channel, callback) {
  var self = this;

  if (!this._exchangeSubscriptions[channel]) {
    this._exchangeSubscriptions[channel] = 'pending';
    this._privateClientCluster.subscribe(channel, function (err) {
      if (err) {
        delete self._exchangeSubscriptions[channel];
        self._dropUnusedSubscriptions(channel);
      } else {
        self._exchangeSubscriptions[channel] = true;
      }
      callback && callback(err);
    });
  } else {
    callback && callback();
  }
};

IOClusterClient.prototype.unsubscribe = function (channel, callback) {
  delete this._exchangeSubscriptions[channel];
  this._dropUnusedSubscriptions(channel, callback);
};

IOClusterClient.prototype.unsubscribeAll = function (callback) {
  var self = this;

  var tasks = [];
  for (var channel in this._exchangeSubscriptions) {
    if (this._exchangeSubscriptions.hasOwnProperty(channel)) {
      delete this._exchangeSubscriptions[channel];
      (function (channel) {
        tasks.push(function (cb) {
          self._dropUnusedSubscriptions(channel, cb);
        });
      })(channel);
    }
  }
  async.parallel(tasks, callback);
};

IOClusterClient.prototype.isSubscribed = function (channel, includePending) {
  if (includePending) {
    return !!this._exchangeSubscriptions[channel];
  }
  return this._exchangeSubscriptions[channel] === true;
};

IOClusterClient.prototype.subscribeClientSocket = function (socket, channels, callback) {
  var self = this;

  if (channels instanceof Array) {
    var tasks = [];
    for (var i in channels) {
      if (channels.hasOwnProperty(i)) {
        (function (channel) {
          tasks.push(function (cb) {
            self._subscribeSingleClientSocket(socket, channel, cb);
          });
        })(channels[i]);
      }
    }
    async.waterfall(tasks, function (err) {
      callback && callback(err);
    });
  } else {
    this._subscribeSingleClientSocket(socket, channels, callback);
  }
};

IOClusterClient.prototype.unsubscribeClientSocket = function (socket, channels, callback) {
  var self = this;

  if (channels == null) {
    channels = [];
    for (var channel in socket.channelSubscriptions) {
      if (socket.channelSubscriptions.hasOwnProperty(channel)) {
        channels.push(channel);
      }
    }
  }
  if (channels instanceof Array) {
    var tasks = [];
    var len = channels.length;
    for (var i = 0; i < len; i++) {
      (function (channel) {
        tasks.push(function (cb) {
          self._unsubscribeSingleClientSocket(socket, channel, cb);
        });
      })(channels[i]);
    }
    async.waterfall(tasks, function (err) {
      callback && callback(err);
    });
  } else {
    this._unsubscribeSingleClientSocket(socket, channels, callback);
  }
};

IOClusterClient.prototype._subscribeSingleClientSocket = function (socket, channel, callback) {
  var self = this;

  if (this._socketChannelLimit && socket.channelSubscriptionCount >= this._socketChannelLimit) {
    callback && callback('Socket ' + socket.id + ' tried to exceed the channel subscription limit of ' +
      this._socketChannelLimit);
  } else {
    if (socket.channelSubscriptionCount == null) {
      socket.channelSubscriptionCount = 0;
    }

    if (socket.channelSubscriptions == null) {
      socket.channelSubscriptions = {};
    }
    if (socket.channelSubscriptions[channel] == null) {
      socket.channelSubscriptions[channel] = true;
      socket.channelSubscriptionCount++;
    }

    var addSubscription = function (err) {
      if (err) {
        delete socket.channelSubscriptions[channel];
        socket.channelSubscriptionCount--;
      } else {
        if (!self._clientSubscribers[channel]) {
          self._clientSubscribers[channel] = {};
        }
        self._clientSubscribers[channel][socket.id] = socket;
      }
      if (!err) {
        socket.emit('subscribe', channel);
      }
      callback && callback(err);
    };

    this._privateClientCluster.subscribe(channel, addSubscription);
  }
};

IOClusterClient.prototype._unsubscribeSingleClientSocket = function (socket, channel, callback) {
  var self = this;

  if (this._clientSubscribers[channel]) {
    delete this._clientSubscribers[channel][socket.id];
    if (isEmpty(this._clientSubscribers[channel])) {
      delete this._clientSubscribers[channel];
    }
  }
  delete socket.channelSubscriptions[channel];
  if (socket.channelSubscriptionCount != null) {
    socket.channelSubscriptionCount--;
  }
  this._dropUnusedSubscriptions(channel, function () {
    socket.emit('unsubscribe', channel);
    callback && callback.apply(self, arguments);
  });
};

IOClusterClient.prototype._handleExchangeMessage = function (channel, message, options) {
  var packet = {
    channel: channel,
    data: message
  };

  var subscriberSockets = this._clientSubscribers[channel];

  for (var i in subscriberSockets) {
    if (subscriberSockets.hasOwnProperty(i)) {
      subscriberSockets[i].emit('#publish', packet);
    }
  }

  this.emit('message', packet);
};
