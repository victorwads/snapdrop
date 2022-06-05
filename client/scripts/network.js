window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => console.log('WS: server connected');
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        console.log('WS:', msg);
        switch (msg.type) {
            case Events.PEERS:
                Events.fire(Events.PEERS, msg.peers);
                break;
            case Events.PEER_JOINED:
                Events.fire(Events.PEER_JOINED, msg.peer);
                break;
            case Events.PEER_LEFT:
                Events.fire(Events.PEER_LEFT, msg.peerId);
                break;
            case Events.SIGNAL:
                Events.fire(Events.SIGNAL, msg);
                break;
            case Events.DISPLAY_NAME:
                Events.fire(Events.DISPLAY_NAME, msg);
                break;
            case Events.PING:
                this.send({ type: Events.PONG });
                break;
            default:
                console.error('WS: unkown message type', msg);
        }
    }

    send(message) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const host = location.protocol.startsWith('https') ? 'snapdrop.net' : location.host // using snapDrop original server temporarily
        const url = protocol + '://' + host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
    }

    _onDisconnect() {
        console.log('WS: server disconnected');
        Events.fire(Events.NOTIFY_USER, 'Connection lost. Retry in 5 seconds...');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }
}

class Peer {

    // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    static uuid() {
        let uuid = '',
            ii;
        for (ii = 0; ii < 32; ii += 1) {
            switch (ii) {
                case 8:
                case 20:
                    uuid += '-';
                    uuid += (Math.random() * 16 | 0).toString(16);
                    break;
                case 12:
                    uuid += '-';
                    uuid += '4';
                    break;
                case 16:
                    uuid += '-';
                    uuid += (Math.random() * 4 | 8).toString(16);
                    break;
                default:
                    uuid += (Math.random() * 16 | 0).toString(16);
            }
        }
        return uuid;
    };

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._files = {}
        this._sendingSimultaneos = 0
        this._totalBytesAccepted = 0;
        this._totalBytesReceived = 0;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        for (let i = 0; i < files.length; i++) {
            this._sendFile(files[i])
        }
    }

    _sendFile(file) {
        file.uuid = Peer.uuid();
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size,
            uuid: file.uuid,
        });
        this._files[file.uuid] = {
            header: file,
            chunker: new FileChunker(
                file,
                chunk => {
                    let uuidBytes = new TextEncoder().encode(file.uuid)
                    let fileBytes = new Uint8Array(chunk);
                    let bytes = new Uint8Array(uuidBytes.byteLength + fileBytes.byteLength);
                    bytes.set(uuidBytes);
                    bytes.set(fileBytes, uuidBytes.byteLength);
                    this._send(bytes)
                },
                offset => this._onPartitionEnd(file.uuid, offset)
            )
        }
    }

    static MAX_SIMULTANEOUS_REQUEST = 5

    _dequeueFile() {
        if (
            this._sendingSimultaneos >= Peer.MAX_SIMULTANEOUS_REQUEST |
            !this._filesQueue.length
        ) return;
        this._sendingSimultaneos++
        const uuid = this._filesQueue.shift();
        this._sendNextPartition(uuid);
    }

    _onPartitionEnd(uuid, offset) {
        this.sendJSON({ type: 'partition', uuid, offset });
    }

    _onReceivedPartitionEnd(uuid, offset) {
        this.sendJSON({ type: 'partition-received', uuid, offset });
    }

    _sendNextPartition(uuid) {
        let chunker = this._files[uuid].chunker
        if (!chunker || chunker.isFileEnd()) return;
        chunker.nextPartition();
    }

    _sendProgress(totalProgress, uuid, fileProgress, ) {
        this.sendJSON({ type: 'progress', uuid, totalProgress, fileProgress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC:', message);
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message.uuid, message.offset);
                break;
            case Events.FILE_DENY:
                this._dequeueFile();
                break;
            case Events.FILE_ACCEPT:
                Events.fire(Events.FILE_ACCEPT, this._files[message.uuid].header)
                this._filesQueue.push(message.uuid);
                this._dequeueFile();
                break
            case 'partition-received':
                this._sendNextPartition(message.uuid);
                break;
            case 'progress':
                const {totalProgress, uuid, fileProgress} = message
                this._onDownloadProgress(totalProgress, uuid, fileProgress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted();
                break;
            case 'text':
                this._onTextReceived(message);
                break;
        }
    }

    _onFileHeader(header) {
        this._files[header.uuid] = {
            header,
            lastProgress: 0,
            digester: new FileDigester({
                name: header.name,
                mime: header.mime,
                size: header.size,
                uuid: header.uuid
            }, file => this._onFileReceived(header.uuid, file))
        }
        Events.fire(Events.FILE_REQUEST, {
            file: header,
            accept: () => {
                this._totalBytesAccepted += header.size
                this.sendJSON({type: Events.FILE_ACCEPT, uuid: header.uuid})
            },
            deny: () => this.sendJSON({type: Events.FILE_DENY, uuid: header.uuid})
        })
    }

    _onChunkReceived(data) {
        if(!data.byteLength) return;

        let uuid = new TextDecoder().decode(data.slice(0,36));
        var chunk = data.slice(36); 
        
        let file = this._files[uuid];
        file.digester.unchunk(chunk);

        this._totalBytesReceived += chunk.byteLength
        const totalProgress = this._totalBytesReceived / this._totalBytesAccepted
        const fileProgress = file.digester.progress;
        this._onDownloadProgress(totalProgress, uuid, fileProgress);

        // occasionally notify sender about our progress 
        if (fileProgress - file.lastProgress < 0.05) return;
        file.lastProgress = fileProgress;

        this._sendProgress(totalProgress, file.header.uuid, file.digester.progress);
    }

    _onDownloadProgress(totalProgress, uuid, fileProgress) {
        Events.fire(Events.FILE_PROGRESS, { sender: this._peerId, uuid, totalProgress, fileProgress });
    }

    _onFileReceived(uuid, proxyFile) {
        Events.fire(Events.FILE_RECEIVED, { file: proxyFile, uuid });
        this.sendJSON({ type: 'transfer-complete', uuid });
    }

    _onTransferCompleted() {
        this._sendingSimultaneos--
        this._reader = null;
        this._dequeueFile();
        Events.fire(Events.NOTIFY_USER, 'File transfer completed.');
    }

    sendText(text) {
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        this.sendJSON({ type: 'text', text: unescaped });
    }

    _onTextReceived(message) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        Events.fire(Events.TEXT_RECEIVED, { text: escaped, sender: this._peerId });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        if (!this._conn) this._openConnection(peerId, isCaller);

        if (isCaller) {
            this._openChannel();
        } else {
            this._conn.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _openConnection(peerId, isCaller) {
        this._isCaller = isCaller;
        this._peerId = peerId;
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
    }

    _openChannel() {
        const channel = this._conn.createDataChannel('data-channel', { 
            ordered: true,
            reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
        });
        channel.binaryType = 'arraybuffer';
        channel.onopen = e => this._onChannelOpened(e);
        this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._conn.setLocalDescription(description)
            .then(_ => this._sendSignal({ sdp: description }))
            .catch(e => this._onError(e));
    }

    _onIceCandidate(event) {
        if (!event.candidate) return;
        this._sendSignal({ ice: event.candidate });
    }

    onServerMessage(message) {
        if (!this._conn) this._connect(message.sender, false);

        if (message.sdp) {
            this._conn.setRemoteDescription(new RTCSessionDescription(message.sdp))
                .then( _ => {
                    if (message.sdp.type === 'offer') {
                        return this._conn.createAnswer()
                            .then(d => this._onDescription(d));
                    }
                })
                .catch(e => this._onError(e));
        } else if (message.ice) {
            this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
        }
    }

    _onChannelOpened(event) {
        console.log('RTC: channel opened with', this._peerId);
        const channel = event.channel || event.target;
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = e => this._onChannelClosed();
        this._channel = channel;
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        if (!this.isCaller) return;
        this._connect(this._peerId, true); // reopen the channel
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed:', this._conn.connectionState);
        switch (this._conn.connectionState) {
            case 'disconnected':
                this._onChannelClosed();
                break;
            case 'failed':
                this._conn = null;
                this._onChannelClosed();
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE Gathering failed');
                break;
            default:
                console.log('ICE Gathering', this._conn.iceConnectionState);
        }
    }

    _onError(error) {
        console.error(error);
    }

    _send(message) {
        if (!this._channel) return this.refresh();
        this._channel.send(message);
    }

    _sendSignal(signal) {
        signal.type = Events.SIGNAL;
        signal.to = this._peerId;
        this._server.send(signal);
    }

    refresh() {
        // check if channel is open. otherwise create one
        if (this._isConnected() || this._isConnecting()) return;
        this._connect(this._peerId, this._isCaller);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    _isConnecting() {
        return this._channel && this._channel.readyState === 'connecting';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on(Events.SIGNAL, e => this._onMessage(e.detail));
        Events.on(Events.PEERS, e => this._onPeers(e.detail));
        Events.on(Events.FILES_SELECTED, e => this._onFilesSelected(e.detail));
        Events.on(Events.SEND_TEXT, e => this._onSendText(e.detail));
        Events.on(Events.PEER_LEFT, e => this._onPeerLeft(e.detail));
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._peer) return;
        peer._peer.close();
    }

}

class WSPeer {
    _send(message) {
        message.to = this._peerId;
        this._server.send(message);
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 128000; // 128 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener(Events.LOAD, e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this._isPartitionEnd() || this.isFileEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        let blob = new Blob(this._buffer, { type: this._mime });
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            blob: blob
        });
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static LOAD = 'load'

    static PEERS = 'peers'
    static PEER_JOINED = 'peer-joined'
    static PEER_LEFT = 'peer-left'
    static PING = 'ping'
    static PONG = 'pong'

    static SIGNAL = 'signal'
    static DISPLAY_NAME = 'display-name'
    static NOTIFY_USER = 'notify-user'

    static FILES_SELECTED = 'files-selected'
    static FILE_PROGRESS = 'file-progress'
    static FILE_RECEIVED = 'file-received'
    static FILE_REQUEST = 'file-request'
    static FILE_ACCEPT = 'file-accept'
    static FILE_DENY = 'file-deny'

    static PASTE = 'paste'
    static SEND_TEXT = 'send-text'
    static TEXT_RECEIVED = 'text-received'
    static TEXT_RECIPIENT = 'text-recipient'
}


RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [{
        urls: 'stun:stun.l.google.com:19302'
    }]
}