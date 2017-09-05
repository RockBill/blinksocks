'use strict';Object.defineProperty(exports,'__esModule',{value:true});var _zlib=require('zlib');var _zlib2=_interopRequireDefault(_zlib);var _utils=require('../utils');var _defs=require('./defs');function _interopRequireDefault(obj){return obj&&obj.__esModule?obj:{default:obj}}const factories={'gzip':[_zlib2.default.createGzip,_zlib2.default.createGunzip],'deflate':[_zlib2.default.createDeflate,_zlib2.default.createInflate]};const options={flush:_zlib2.default.Z_PARTIAL_FLUSH};class ExpCompressPreset extends _defs.IPreset{static checkParams({method}){const methods=Object.keys(factories);if(!methods.includes(method)){throw Error(`'method' must be one of [${methods}]`)}}constructor({method}){super();this._method='';this._compressor=null;this._decompressor=null;this._outBytesA=0;this._outBytesB=0;this._inBytesA=0;this._inBytesB=0;this._method=method}onNotified(action){if(action.type===_defs.CONNECTION_CLOSED){_utils.logger.debug(`compression ratio: ${this._outBytesB/this._outBytesA}`);_utils.logger.debug(`decompression ratio: ${this._inBytesB/this._inBytesA}`)}}beforeOut({buffer,next,fail}){if(this._compressor===null){this._compressor=factories[this._method][0](options);this._compressor.on('error',err=>fail(err.message));this._compressor.on('data',buf=>{this._outBytesB+=buf.length;next(buf)})}this._compressor.write(buffer);this._outBytesA+=buffer.length}beforeIn({buffer,next,fail}){if(this._decompressor===null){this._decompressor=factories[this._method][1](options);this._decompressor.on('error',err=>fail(err.message));this._decompressor.on('data',buf=>{this._inBytesB+=buf.length;next(buf)})}this._decompressor.write(buffer);this._inBytesA+=buffer.length}}exports.default=ExpCompressPreset;