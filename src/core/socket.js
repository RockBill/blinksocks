import net from 'net';
import logger from 'winston';
import {Address} from './address';
import {DNSCache} from './dns-cache';
import {Pipe} from './pipe';
import {
  MIDDLEWARE_DIRECTION_UPWARD,
  MIDDLEWARE_DIRECTION_DOWNWARD,
  MIDDLEWARE_TYPE_FRAME,
  MIDDLEWARE_TYPE_CRYPTO,
  MIDDLEWARE_TYPE_PROTOCOL,
  MIDDLEWARE_TYPE_OBFS,
  createMiddleware
} from './middleware';

import {Utils} from '../utils';
import {
  SOCKET_CONNECT_TO_DST
} from '../presets/actions';

import {
  IdentifierMessage,
  SelectMessage,
  RequestMessage as Socks5RequestMessage,
  ReplyMessage as Socks5ReplyMessage,
  UdpRequestMessage
  // UdpRequestMessage
} from '../proxies/socks5';

import {
  RequestMessage as Socks4RequestMessage,
  ReplyMessage as Socks4ReplyMessage
} from '../proxies/socks4';

import {
  HttpRequestMessage,
  ConnectReplyMessage
} from '../proxies/http';

import {
  ATYP_V4,
  ATYP_DOMAIN,
  REQUEST_COMMAND_CONNECT,
  REQUEST_COMMAND_UDP,
  REPLY_GRANTED,
  REPLY_SUCCEEDED,
  REPLY_COMMAND_NOT_SUPPORTED
} from '../proxies/common';

const dnsCache = DNSCache.create();

export class Socket {

  _id = null;

  _bsocket = null;

  _fsocket = null;

  _socksTcpReady = false;

  _socksUdpReady = false;

  _httpReady = false;

  _targetAddress = null;

  _pipe = null;

  constructor({id, socket}) {
    this._id = id;
    this._bsocket = socket;
    // handle events
    this._bsocket.on('error', (err) => this.onError(err));
    this._bsocket.on('close', (had_error) => this.onClose(had_error));
    this._bsocket.on('data', (buffer) => this.onForward(buffer));
    if (__IS_SERVER__) {
      this.createPipe();
    }
  }

  isHandshakeDone() {
    return [this._socksTcpReady, this._socksUdpReady, this._httpReady].some((v) => !!v);
  }

  onForward(buffer) {
    if (__IS_CLIENT__ && !this.isHandshakeDone()) {
      // client handshake(multiple-protocols), client only
      this.onHandshake(buffer);
      return;
    }

    let _buffer = buffer;

    // udp compatible
    if (__IS_CLIENT__ && this._socksUdpReady) {
      const request = UdpRequestMessage.parse(buffer);
      if (request !== null) {
        // just drop RSV and FRAG
        _buffer = request.DATA;
      } else {
        logger.warn(`[${this._id}] -x-> dropped unidentified packet ${buffer.length} bytes`);
        return;
      }
    }

    try {
      this._pipe.feed(
        __IS_CLIENT__
          ? MIDDLEWARE_DIRECTION_UPWARD
          : MIDDLEWARE_DIRECTION_DOWNWARD,
        _buffer
      );
    } catch (err) {
      logger.error(`[${this._id}]`, err);
    }
  }

  onBackward(buffer) {
    try {
      this._pipe.feed(
        __IS_CLIENT__
          ? MIDDLEWARE_DIRECTION_DOWNWARD
          : MIDDLEWARE_DIRECTION_UPWARD,
        buffer
      );
    } catch (err) {
      logger.error(`[${this._id}]`, err);
    }
  }

  onError(err) {
    switch (err.code) {
      case 'ECONNREFUSED':
      case 'EADDRNOTAVAIL':
      case 'ENETDOWN':
      case 'ECONNRESET':
      case 'ETIMEDOUT':
      case 'EAI_AGAIN':
      case 'EPIPE':
        logger.warn(`[${this._id}] ${err.message}`);
        return;
      default:
        logger.error(err);
        break;
    }
    this.onClose(true);
  }

  onClose(had_error) {
    if (had_error) {
      logger.warn(`client[${this._id}] closed due to a transmission error`);
    } else {
      logger.info(`client[${this._id}] closed normally`);
    }
    if (this._bsocket !== null && !this._bsocket.destroyed) {
      this._bsocket.end();
      this._bsocket = null;
    }
    if (this._fsocket !== null && !this._fsocket.destroyed) {
      this._fsocket.end();
      this._fsocket = null;
    }
  }

  send(buffer, flag) {
    if (flag) {
      this._fsocket && this._fsocket.write(buffer);
    } else {
      this._bsocket && this._bsocket.write(buffer);
    }
  }

  /**
   * create pipes for both data forward and backward
   */
  createPipe() {
    if (__IS_CLIENT__) {
      this._pipe = new Pipe();
    } else {
      this._pipe = new Pipe({
        onNotified: (action) => {
          if (action.type === SOCKET_CONNECT_TO_DST) {
            this.connectToDst(...action.payload);
          }
        }
      });
    }
    this._pipe.setMiddlewares(MIDDLEWARE_DIRECTION_UPWARD, [
      createMiddleware(MIDDLEWARE_TYPE_FRAME, [this._targetAddress]),
      createMiddleware(MIDDLEWARE_TYPE_CRYPTO),
      createMiddleware(MIDDLEWARE_TYPE_PROTOCOL),
      createMiddleware(MIDDLEWARE_TYPE_OBFS),
    ]);
    this._pipe.on(`next_${MIDDLEWARE_DIRECTION_UPWARD}`, (buf) => this.send(buf, __IS_CLIENT__));
    this._pipe.on(`next_${MIDDLEWARE_DIRECTION_DOWNWARD}`, (buf) => this.send(buf, __IS_SERVER__));
  }

  /**
   * connect to blinksocks server
   * @returns {Promise}
   */
  connectToServer() {
    return new Promise((resolve, reject) => {
      const ep = {
        host: __SERVER_HOST__,
        port: __SERVER_PORT__
      };
      this._fsocket = net.connect(ep);
      this._fsocket.on('connect', () => {
        logger.info(`[${this._id}] connected to:`, ep);
        this.createPipe();
        resolve();
      });
      this._fsocket.on('error', (err) => reject(err));
      this._fsocket.on('close', (had_error) => this.onClose(had_error));
      this._fsocket.on('data', (buffer) => this.onBackward(buffer));
    });
  }

  /**
   * connect to the real server, server side only
   * @param address
   * @param callback
   * @returns {Promise.<void>}
   */
  async connectToDst(address, callback) {
    const [host, port] = address.getEndPoint();
    try {
      const ip = await dnsCache.get(host);
      this._fsocket = net.connect({host: ip, port}, () => {
        logger.info(`[${this._id}] connected to:`, {host, port});
        callback();
      });
      this._fsocket.on('error', (err) => this.onError(err));
      this._fsocket.on('close', (had_error) => this.onClose(had_error));
      this._fsocket.on('data', (buffer) => this.onBackward(buffer));
    } catch (err) {
      logger.error(err.message);
    }
  }

  /*** client handshake, multiple protocols ***/

  onHandshake(buffer) {
    this.trySocksHandshake(this._bsocket, buffer);
    if (!this.isHandshakeDone()) {
      this.tryHttpHandshake(this._bsocket, buffer);
    }
  }

  onHandshakeDone(callback) {
    this.connectToServer().then(callback).catch(this.onError.bind(this));
  }

  trySocksHandshake(socket, buffer) {
    if (!this.isHandshakeDone()) {
      this.trySocks5Handshake(socket, buffer);
    }
    if (!this.isHandshakeDone()) {
      this.trySocks4Handshake(socket, buffer);
    }
  }

  trySocks4Handshake(socket, buffer) {
    const request = Socks4RequestMessage.parse(buffer);
    if (request !== null) {
      const {CMD, DSTIP, DSTADDR, DSTPORT} = request;
      if (CMD === REQUEST_COMMAND_CONNECT) {
        this._targetAddress = new Address({
          ATYP: DSTADDR.length > 0 ? ATYP_DOMAIN : ATYP_V4,
          DSTADDR: DSTADDR.length > 0 ? DSTADDR : DSTIP,
          DSTPORT
        });
        this.onHandshakeDone(() => {
          // reply success
          const message = new Socks4ReplyMessage({CMD: REPLY_GRANTED});
          socket.write(message.toBuffer());
          this._socksTcpReady = true;
        });
      }
    }
  }

  trySocks5Handshake(socket, buffer) {
    // 1. IDENTIFY
    const identifier = IdentifierMessage.parse(buffer);
    if (identifier !== null) {
      const message = new SelectMessage();
      socket.write(message.toBuffer());
      return;
    }

    // 2. REQUEST
    const request = Socks5RequestMessage.parse(buffer);
    if (request !== null) {
      const type = request.CMD;
      switch (type) {
        case REQUEST_COMMAND_UDP: // UDP ASSOCIATE
        case REQUEST_COMMAND_CONNECT: {
          this._targetAddress = new Address({
            ATYP: request.ATYP,
            DSTADDR: request.DSTADDR,
            DSTPORT: request.DSTPORT
          });
          this.onHandshakeDone(() => {
            // reply success
            const message = new Socks5ReplyMessage({REP: REPLY_SUCCEEDED});
            socket.write(message.toBuffer());

            if (type === REQUEST_COMMAND_CONNECT) {
              this._socksTcpReady = true;
            } else {
              this._socksUdpReady = true;
            }
          });
          break;
        }
        default: {
          const message = new Socks5ReplyMessage({REP: REPLY_COMMAND_NOT_SUPPORTED});
          socket.write(message.toBuffer());
          break;
        }
      }
    }
  }

  tryHttpHandshake(socket, buffer) {
    const request = HttpRequestMessage.parse(buffer);
    if (request !== null) {
      const {METHOD, HOST} = request;

      this._targetAddress = Utils.hostToAddress(HOST.toString());
      this._httpReady = true;

      if (METHOD.toString() === 'CONNECT') {
        this.onHandshakeDone(() => {
          const message = new ConnectReplyMessage();
          socket.write(message.toBuffer());
        });
      } else {
        // for clients who haven't sent CONNECT, should begin to relay immediately
        this.onReceiving(socket, buffer);
      }
    }
  }

}
