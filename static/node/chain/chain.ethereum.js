#!/usr/bin/env node

const ganacheLib = require("ganache");
const logging = require("./logging");

if (!process.send) {
  console.log("Not running as child process. Throwing.");
  throw new Error("Must be run as a child process!");
}

// remove the uncaughtException listener added by ganache-cli
process.removeAllListeners("uncaughtException");

process.on("unhandledRejection", (err) => {
  //console.log('unhandled rejection:', err.stack || err)
  process.send({ type: "error", data: copyErrorFields(err) });
});

process.on("uncaughtException", (err) => {
  //console.log('uncaught exception:', err.stack || err)
  process.send({ type: "error", data: copyErrorFields(err) });
});

let server;
let blockInterval;
let dbLocation;

async function stopServer() {
  clearInterval(blockInterval);

  if (server) {
    try {
      await server.close();
    } catch (e) {
      if (!e.message.includes("Server is already closing or closed")) {
        throw e;
      }
    }
    process.send({ type: "server-stopped" });
  } else {
    process.send({ type: "server-stopped" });
  }
}

async function startServer(options) {
  await stopServer();

  let sanitizedOptions = Object.assign({}, options);
  if (sanitizedOptions.chain && sanitizedOptions.chain.mnemonic) {
    delete sanitizedOptions.chain.mnemonic;
  }

  const logToFile =
    options.logDirectory !== null && typeof options.logDirectory === "string";

  // Initialize option namespaces to prevent '<> of undefined'
  // errors down the road
  if (typeof options.chain === "undefined") {
    options.chain = {};
  }
  if (typeof options.database === "undefined") {
    options.database = {};
  }
  if (typeof options.logging === "undefined") {
    options.logging = {};
  }
  if (typeof options.miner === "undefined") {
    options.miner = {};
  }
  if (typeof options.wallet === "undefined") {
    options.wallet = {};
  }

  if (typeof options.logging.logger === "undefined") {
    if (logToFile) {
      logging.generateLogFilePath(options.logDirectory);

      options.logging.logger = {
        log: (message) => {
          if (typeof message === "string") {
            logging.logToFile(message);
          }
        },
      };
    } else {
      options.logging.logger = {
        log: (message) => {
          if (typeof message === "string") {
            console.log(message);
          }
        },
      };
    }
  }

  // log startup options without logging user's mnemonic
  const startingMessage = `Starting server with initial configuration: ${JSON.stringify(
    sanitizedOptions
  )}`;
  console.log(startingMessage);
  if (logToFile) {
    logging.logToFile(startingMessage);
  }

  options.wallet = options.wallet || {};
  server = ganacheLib.server(options);

  try {
    await server.listen(options.port, options.hostname);
  } catch (err) {
    process.send({
      type: "start-error",
      data: { code: err.code, stack: err.stack, message: err.message },
    });
    return;
  }

  // We'll also log all methods that aren't marked internal by Ganache
  var oldSend = server.provider.send.bind(server.provider);
  server.provider.send = (payload, callback) => {
    if (payload.internal !== true) {
      if (Array.isArray(payload)) {
        payload.forEach(function(item) {
          console.log(item.method);
        });
      } else {
        console.log(payload.method);
      }
    }

    oldSend(payload, callback);
  };

  const privateKeys = {};

  const accounts = await server.provider.getInitialAccounts();
  const addresses = Object.keys(accounts);

  addresses.forEach((address) => {
    privateKeys[address] = accounts[address].secretKey;
  });

  const ganacheOptions = server.provider.getOptions();

  dbLocation = ganacheOptions.database.dbPath;

  const { mnemonic, hdPath } = ganacheOptions.wallet;

  // todo: what else do we need from options
  const data = {
    privateKeys,
    addresses,
    hdPath,
    mnemonic,
    dbLocation,
  };

  process.send({ type: "server-started", data: data });

  console.log("Ganache started successfully!");
  console.log("Waiting for requests...");

  server.on("close", () => {
    server = null;
    process.send({ type: "server-stopped" });
  });
}

function getDbLocation() {
  process.send({ type: "db-location", data: dbLocation || null });
}

process.on("message", (message) => {
  //console.log("CHILD RECEIVED", message)
  switch (message.type) {
    case "start-server":
      startServer(message.data);
      break;
    case "stop-server":
      stopServer();
      break;
    case "get-db-location":
      getDbLocation();
      break;
  }
});

function copyErrorFields(e) {
  let err = Object.assign({}, e);

  // I think these properties aren't enumerable on Error objects, so we copy
  // them manually if we don't do this, they aren't passed via IPC back to the
  // main process
  err.message = e.message;
  err.stack = e.stack;
  err.name = e.name;

  return err;
}

process.send({ type: "process-started" });
