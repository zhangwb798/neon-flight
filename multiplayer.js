/**
 * NEON FLIGHT 多人联机模块
 *
 * TapTap 小游戏/H5 运行时会注入全局 tap 对象。
 * API 频率限制：sendCustomMessage 等共享每秒 15 次，本模块将状态同步限制为约 8 次/秒。
 * 详细规范请参阅 MULTIPLAYER_GUIDE.md。
 */
(function () {
  'use strict';

  class NeonMultiplayer {
    constructor() {
      this.manager = null;
      this.myPlayerId = null;
      this.roomInfo = null;
      this.isOnline = false;
      this.isConnected = false;
      this.isInRoom = false;
      this.isHost = false;
      this.remotePlayers = new Map();
      this.lastSyncAt = 0;
      this.lastSendAt = 0;
      this.syncInterval = 125;
      this.maxMessageSize = 2048;
      this.onPlayerJoined = null;
      this.onPlayerLeft = null;
      this.onDataReceived = null;
      this.onRoomJoined = null;
      this.onDisconnected = null;
    }

    isSupported() {
      return typeof window.tap !== 'undefined' && typeof window.tap.getOnlineBattleManager === 'function';
    }

    playerIdFrom(info) {
      const player = info && (info.playerInfo || info);
      return player && (player.id || player.playerId || player.fromPlayerId || player.fromUserId);
    }

    async init() {
      if (!this.isSupported()) return { success: false, unsupported: true, error: '当前浏览器没有 TapTap 联机运行时' };
      try {
        this.manager = window.tap.getOnlineBattleManager();
        this.registerListeners();
        const result = await this.manager.connect();
        this.myPlayerId = result.playerId;
        this.isOnline = true;
        this.isConnected = true;
        return { success: true, playerId: this.myPlayerId };
      } catch (error) {
        return { success: false, error: this.formatError(error) };
      }
    }

    registerListeners() {
      this.manager.registerListener({
        onDisconnected: info => {
          this.isConnected = false;
          this.isInRoom = false;
          if (this.onDisconnected) this.onDisconnected(info && info.reason, info && info.code);
        },
        playerEnterRoom: info => {
          const id = this.playerIdFrom(info);
          if (!id || id === this.myPlayerId) return;
          this.remotePlayers.set(id, { id });
          if (this.onPlayerJoined) this.onPlayerJoined(info.playerInfo || info);
        },
        playerLeaveRoom: info => this.handleLeave(info),
        playerOffline: info => this.handleLeave(info),
        onCustomMessage: info => {
          const fromId = this.playerIdFrom(info);
          if (!fromId || fromId === this.myPlayerId) return;
          const raw = info.msg || info.message || info.content;
          try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (this.onDataReceived) this.onDataReceived(data, fromId);
          } catch (error) {
            console.warn('[NEON multiplayer] 无法解析消息', error);
          }
        }
      });
    }

    handleLeave(info) {
      const id = this.playerIdFrom(info);
      if (!id) return;
      this.remotePlayers.delete(id);
      if (this.onPlayerLeft) this.onPlayerLeft(id);
    }

    async matchRoom(maxPlayers = 4, roomType = 'neon_survival_v1', playerProps = {}) {
      if (!this.isConnected) return { success: false, error: '尚未连接 TapTap 联机服务' };
      try {
        const result = await this.manager.matchRoom({
          data: {
            roomCfg: { maxPlayerCount: Math.min(4, Math.max(2, maxPlayers)), type: roomType },
            playerCfg: { customProperties: JSON.stringify(playerProps) }
          }
        });
        this.roomInfo = result.roomInfo;
        this.isInRoom = true;
        this.isHost = this.roomInfo.ownerId === this.myPlayerId;
        for (const player of this.roomInfo.players || []) {
          if (player.id === this.myPlayerId) continue;
          this.remotePlayers.set(player.id, { id: player.id });
          if (this.onPlayerJoined) this.onPlayerJoined(player);
        }
        if (this.onRoomJoined) this.onRoomJoined(this.roomInfo);
        return { success: true, roomInfo: this.roomInfo };
      } catch (error) {
        return { success: false, error: this.formatError(error), code: error && error.code };
      }
    }

    sendNow(data) {
      if (!this.isOnline || !this.isInRoom) return false;
      const message = JSON.stringify(data);
      if (new Blob([message]).size > this.maxMessageSize) return false;
      this.manager.sendCustomMessage({ data: { msg: message, type: 0 } });
      this.lastSendAt = Date.now();
      return true;
    }

    sendEvent(eventType, payload = {}) {
      const send = () => this.sendNow({ type: 'event', eventType, ...payload });
      const wait = Math.max(0, 70 - (Date.now() - this.lastSendAt));
      if (wait) setTimeout(send, wait); else send();
    }

    syncState(state) {
      const now = Date.now();
      if (now - this.lastSyncAt < this.syncInterval) return false;
      this.lastSyncAt = now;
      return this.sendNow({ type: 'state', ...state });
    }

    async leaveRoom() {
      if (this.isOnline && this.isInRoom && this.manager) {
        try { await this.manager.leaveRoom(); } catch (error) { console.warn('[NEON multiplayer] 离开房间失败', error); }
      }
      this.roomInfo = null;
      this.isInRoom = false;
      this.isHost = false;
      this.remotePlayers.clear();
    }

    formatError(error) {
      if (!error) return '未知错误';
      return error.message || error.errMsg || error.msg || String(error);
    }
  }

  window.NeonMultiplayer = NeonMultiplayer;
})();

