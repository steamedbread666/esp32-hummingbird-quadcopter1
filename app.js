/**
 * ESP32 Drone BLE Control — Web client (Phase 1 framework)
 *
 * Modules (adjust without rewriting everything):
 *   CONFIG     — UUIDs, rates, limits
 *   Protocol   — pack/unpack binary control + telemetry
 *   Stick      — virtual joystick
 *   Gamepad    — optional physical controller
 *   Ble        — Web Bluetooth session
 *   App        — UI wiring / state
 */

// ========== CONFIG (edit here) ==========
const CONFIG = {
  // Must match firmware
  serviceUuid: "0000ff01-0000-1000-8000-00805f9b34fb",
  controlCharUuid: "0000ff02-0000-1000-8000-00805f9b34fb", // write
  telemetryCharUuid: "0000ff03-0000-1000-8000-00805f9b34fb", // notify
  statusCharUuid: "0000ff04-0000-1000-8000-00805f9b34fb", // read optional

  deviceNamePrefix: "ESP32-Drone", // requestDevice filter
  defaultHz: 20,
  armHoldMs: 800,
  stickDeadzone: 0.08,
  // Phase 1: throttle sticks up only (0..1); later can enable full -1..1
  throttleRange: { min: 0, max: 1 },
  attitudeRange: { min: -1, max: 1 },
};

// ========== Protocol ==========
// Control packet (8 bytes, little-endian friendly)
// [0] magic 0xA5
// [1] ver   0x01
// [2] flags bit0=armed bit1=land bit2=estop bit3=mode(0 angle|1 acro)
// [3] throttle 0..255
// [4] yaw      0..255  (128 center)
// [5] pitch    0..255  (128 center)
// [6] roll     0..255  (128 center)
// [7] checksum = sum(bytes[0..6]) & 0xFF
const Protocol = {
  MAGIC: 0xa5,
  VER: 0x01,

  map01(v) {
    const x = Math.max(0, Math.min(1, v));
    return Math.round(x * 255);
  },

  mapSigned(v) {
    // -1..1 → 0..255, center 128
    const x = Math.max(-1, Math.min(1, v));
    return Math.round(((x + 1) / 2) * 255);
  },

  packControl({ armed, land, estop, mode, throttle, yaw, pitch, roll }) {
    const b = new Uint8Array(8);
    b[0] = Protocol.MAGIC;
    b[1] = Protocol.VER;
    b[2] = (armed ? 1 : 0) | (land ? 2 : 0) | (estop ? 4 : 0) | ((mode ? 1 : 0) << 3);
    b[3] = Protocol.map01(throttle);
    b[4] = Protocol.mapSigned(yaw);
    b[5] = Protocol.mapSigned(pitch);
    b[6] = Protocol.mapSigned(roll);
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += b[i];
    b[7] = sum & 0xff;
    return b;
  },

  // Telemetry notify: [batt%, pitch_i16, roll_i16, alt_cm_u16, flags] — extend as needed
  unpackTelemetry(buf) {
    const d = new DataView(buf.buffer ?? buf);
    if (buf.byteLength < 8) return null;
    const batt = d.getUint8(0);
    const pitch = d.getInt16(1, true) / 100; // deg
    const roll = d.getInt16(3, true) / 100;
    const altCm = d.getUint16(5, true);
    const flags = d.getUint8(7);
    return {
      batt,
      pitch,
      roll,
      alt: altCm / 100,
      armed: !!(flags & 1),
      mode: (flags >> 1) & 1,
    };
  },
};

// ========== Stick ==========
class Stick {
  /**
   * @param {HTMLElement} root stick container
   * @param {HTMLElement} knob
   * @param {{selfCenterY?: boolean}} opts
   */
  constructor(root, knob, opts = {}) {
    this.root = root;
    this.knob = knob;
    this.selfCenterY = !!opts.selfCenterY;
    this.x = 0; // -1..1 (yaw / roll)
    this.y = 0; // -1..1 (throttle up positive, pitch forward positive)
    this.active = false;
    this._pointerId = null;
    this._bind();
  }

  _bind() {
    this.root.addEventListener("pointerdown", (e) => this._down(e));
    this.root.addEventListener("pointermove", (e) => this._move(e));
    this.root.addEventListener("pointerup", (e) => this._up(e));
    this.root.addEventListener("pointercancel", (e) => this._up(e));
    this.root.addEventListener("lostpointercapture", (e) => this._up(e));
  }

  _pos(e) {
    const r = this.root.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width / 2;
    let dx = (e.clientX - cx) / max;
    let dy = (e.clientY - cy) / max;
    // screen Y down → stick Y up = positive throttle/pitch
    dy = -dy;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    const dz = CONFIG.stickDeadzone;
    const applyDead = (v) => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      return Math.sign(v) * ((a - dz) / (1 - dz));
    };
    return { x: applyDead(dx), y: applyDead(dy) };
  }

  _down(e) {
    if (this._pointerId !== null) return;
    this._pointerId = e.pointerId;
    this.root.setPointerCapture(e.pointerId);
    this.active = true;
    this._apply(this._pos(e));
  }

  _move(e) {
    if (e.pointerId !== this._pointerId) return;
    this._apply(this._pos(e));
  }

  _up(e) {
    if (e.pointerId !== this._pointerId) return;
    this._pointerId = null;
    this.active = false;
    this.x = 0;
    if (this.selfCenterY) this.y = 0;
    this._render();
  }

  setFromAxes(x, y) {
    this.x = x;
    this.y = y;
    this._render();
  }

  _apply(p) {
    this.x = p.x;
    this.y = p.y;
    this._render();
  }

  _render() {
    const pctX = 50 + this.x * 29;
    const pctY = 50 - this.y * 29;
    this.knob.style.left = pctX + "%";
    this.knob.style.top = pctY + "%";
  }

  /** normalized for protocol */
  get throttle() {
    // map -1..1 stick → 0..1 (center = 0 for safety on first use if wanted)
    const t = (this.y + 1) / 2;
    return CONFIG.throttleRange.min + t * (CONFIG.throttleRange.max - CONFIG.throttleRange.min);
  }

  get yaw() {
    return this.x;
  }

  get pitch() {
    return this.y;
  }

  get roll() {
    return this.x;
  }
}

// ========== Gamepad ==========
const Gamepad = {
  enabled: true,
  _index: null,

  init(onChange) {
    window.addEventListener("gamepadconnected", (e) => {
      this._index = e.gamepad.index;
      onChange?.(e.gamepad.id);
    });
    window.addEventListener("gamepaddisconnected", () => {
      this._index = null;
      onChange?.(null);
    });
  },

  read() {
    if (!this.enabled || this._index == null) return null;
    const pads = navigator.getGamepads?.() || [];
    const gp = pads[this._index];
    if (!gp) return null;
    const ax = (i) => {
      const v = gp.axes[i] ?? 0;
      return Math.abs(v) < 0.12 ? 0 : v;
    };
    // Common mapping: L stick yaw/throttle, R stick roll/pitch — adjustable
    return {
      yaw: ax(0),
      throttleAxis: -ax(1), // up positive
      roll: ax(2),
      pitch: -ax(3),
    };
  },
};

// ========== BLE ==========
class Ble {
  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.controlChar = null;
    this.telemetryChar = null;
    this._notifyHandler = null;
  }

  get connected() {
    return !!(this.device && this.device.gatt?.connected);
  }

  async connect({ onTelemetry, onDisconnect } = {}) {
    if (!navigator.bluetooth) {
      throw new Error("当前浏览器不支持 Web Bluetooth，请用 Chrome/Edge");
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: CONFIG.deviceNamePrefix },
        { services: [CONFIG.serviceUuid] },
      ],
      optionalServices: [CONFIG.serviceUuid],
    });
    this.device.addEventListener("gattserverdisconnected", () => onDisconnect?.());
    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(CONFIG.serviceUuid);
    this.controlChar = await this.service.getCharacteristic(CONFIG.controlCharUuid);
    try {
      this.telemetryChar = await this.service.getCharacteristic(CONFIG.telemetryCharUuid);
      this._notifyHandler = (ev) => {
        const v = ev.target.value;
        onTelemetry?.(Protocol.unpackTelemetry(v));
      };
      await this.telemetryChar.startNotifications();
      this.telemetryChar.addEventListener("characteristicvaluechanged", this._notifyHandler);
    } catch {
      this.telemetryChar = null; // firmware may not expose yet
    }
    return this.device;
  }

  async disconnect() {
    try {
      if (this.telemetryChar && this._notifyHandler) {
        this.telemetryChar.removeEventListener("characteristicvaluechanged", this._notifyHandler);
      }
    } catch {
      /* ignore */
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.device = null;
    this.controlChar = null;
    this.telemetryChar = null;
  }

  async writeControl(bytes) {
    if (!this.controlChar) throw new Error("未连接");
    // Prefer writeWithoutResponse if supported (faster); fallback write
    if (this.controlChar.properties.writeWithoutResponse) {
      await this.controlChar.writeValueWithoutResponse(bytes);
    } else {
      await this.controlChar.writeValue(bytes);
    }
  }
}

// ========== App ==========
const App = {
  ble: new Ble(),
  stickL: null,
  stickR: null,
  sendHz: CONFIG.defaultHz,
  armed: false,
  land: false,
  estop: false,
  mode: 0, // 0 angle, 1 acro
  _timer: null,
  _armStart: 0,
  _armRaf: null,
  _lastPadName: null,

  els: {},

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      bleLed: $("bleLed"),
      bleStatus: $("bleStatus"),
      btnConnect: $("btnConnect"),
      btnDisconnect: $("btnDisconnect"),
      tBatt: $("tBatt"),
      tAtt: $("tAtt"),
      tAlt: $("tAlt"),
      tRssi: $("tRssi"),
      tMode: $("tMode"),
      tArm: $("tArm"),
      warnBanner: $("warnBanner"),
      valsLeft: $("valsLeft"),
      valsRight: $("valsRight"),
      btnArm: $("btnArm"),
      armRing: $("armRing"),
      armLabel: $("armLabel"),
      btnLand: $("btnLand"),
      btnEstop: $("btnEstop"),
      btnModeAngle: $("btnModeAngle"),
      btnModeAcro: $("btnModeAcro"),
      rateRange: $("rateRange"),
      rateLabel: $("rateLabel"),
      chkGamepad: $("chkGamepad"),
      log: $("log"),
    };

    this.stickL = new Stick($("stickLeft"), $("knobLeft"), { selfCenterY: false });
    this.stickR = new Stick($("stickRight"), $("knobRight"), { selfCenterY: true });

    this._bindUi();
    Gamepad.init((name) => {
      this._lastPadName = name;
      this.log(name ? `手柄已连接: ${name}` : "手柄已断开");
    });

    this.log("就绪。点「连接蓝牙」选择 " + CONFIG.deviceNamePrefix + "*");
  },

  log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const el = this.els.log;
    el.textContent = `[${t}] ${msg}\n` + el.textContent.slice(0, 2000);
  },

  setWarn(text) {
    const el = this.els.warnBanner;
    if (!text) {
      el.classList.add("hidden");
      el.textContent = "";
    } else {
      el.classList.remove("hidden");
      el.textContent = text;
    }
  },

  setBleState(state, label) {
    this.els.bleLed.dataset.state = state;
    this.els.bleStatus.textContent = label;
    this.els.btnConnect.disabled = state === "connecting" || state === "on";
    this.els.btnDisconnect.disabled = state !== "on";
  },

  _bindUi() {
    const E = this.els;

    E.btnConnect.addEventListener("click", async () => {
      try {
        this.setBleState("connecting", "连接中…");
        this.log("请求蓝牙设备…");
        await this.ble.connect({
          onTelemetry: (t) => this._onTelemetry(t),
          onDisconnect: () => {
            this._stopSend();
            this.armed = false;
            this._syncArmUi();
            this.setBleState("off", "已断开");
            this.setWarn("蓝牙已断开");
            this.log("GATT 断开");
          },
        });
        this.setBleState("on", this.ble.device?.name || "已连接");
        this.setWarn("");
        this.log("已连接 GATT");
        this._startSend();
      } catch (err) {
        this.setBleState("error", "连接失败");
        this.log("连接失败: " + err.message);
        this.setWarn(err.message);
      }
    });

    E.btnDisconnect.addEventListener("click", async () => {
      await this.ble.disconnect();
      this._stopSend();
      this.armed = false;
      this._syncArmUi();
      this.setBleState("off", "未连接");
      this.log("主动断开");
    });

    E.btnEstop.addEventListener("click", () => {
      this.estop = true;
      this.armed = false;
      this.stickL.setFromAxes(0, -1);
      this.stickR.setFromAxes(0, 0);
      this._syncArmUi();
      this.setWarn("紧急停机已触发");
      this.log("ESTOP");
      // one-shot packet then clear estop so it doesn't stick forever
      this._sendOnce(true);
      setTimeout(() => {
        this.estop = false;
      }, 200);
    });

    E.btnLand.addEventListener("click", () => {
      this.land = !this.land;
      E.btnLand.textContent = this.land ? "取消降落" : "一键降落";
      if (this.land) {
        this.stickL.setFromAxes(0, -1);
        this.stickR.setFromAxes(0, 0);
        this.armed = false;
        this._syncArmUi();
        this.log("降落指令");
      }
    });

    const setMode = (m) => {
      this.mode = m;
      E.btnModeAngle.classList.toggle("active", m === 0);
      E.btnModeAcro.classList.toggle("active", m === 1);
      E.tMode.textContent = m === 0 ? "稳定" : "手动";
      this.log("模式 → " + (m === 0 ? "稳定" : "手动"));
    };
    E.btnModeAngle.addEventListener("click", () => setMode(0));
    E.btnModeAcro.addEventListener("click", () => setMode(1));

    // Hold-to-arm
    const ringC = 2 * Math.PI * 30;
    const startArmHold = (e) => {
      e.preventDefault();
      if (this.armed) {
        // instant disarm
        this.armed = false;
        this._syncArmUi();
        this.log("已上锁");
        return;
      }
      this._armStart = performance.now();
      const tick = () => {
        if (!this._armStart) return;
        const p = Math.min(1, (performance.now() - this._armStart) / CONFIG.armHoldMs);
        E.armRing.style.strokeDashoffset = String(ringC * (1 - p));
        if (p >= 1) {
          this._armStart = 0;
          E.armRing.style.strokeDashoffset = String(ringC);
          this.armed = true;
          this.land = false;
          E.btnLand.textContent = "一键降落";
          this.setWarn("");
          this._syncArmUi();
          this.log("已解锁（确保无桨或安全环境）");
          return;
        }
        this._armRaf = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(this._armRaf);
      tick();
    };
    const cancelArmHold = () => {
      if (!this.armed) {
        this._armStart = 0;
        E.armRing.style.strokeDashoffset = String(ringC);
      }
    };
    E.btnArm.addEventListener("pointerdown", startArmHold);
    E.btnArm.addEventListener("pointerup", cancelArmHold);
    E.btnArm.addEventListener("pointerleave", cancelArmHold);
    E.btnArm.addEventListener("pointercancel", cancelArmHold);

    E.rateRange.addEventListener("input", () => {
      this.sendHz = Number(E.rateRange.value);
      E.rateLabel.textContent = this.sendHz + " Hz";
      if (this.ble.connected) this._restartSend();
    });

    E.chkGamepad.addEventListener("change", () => {
      Gamepad.enabled = E.chkGamepad.checked;
    });
  },

  _syncArmUi() {
    const E = this.els;
    E.btnArm.dataset.armed = this.armed ? "true" : "false";
    E.armLabel.textContent = this.armed ? "已解锁·点锁" : "长按解锁";
    E.tArm.textContent = this.armed ? "已解锁" : "未解锁";
  },

  _onTelemetry(t) {
    if (!t) return;
    this.els.tBatt.textContent = t.batt + "%";
    this.els.tAtt.textContent = `${t.pitch.toFixed(0)}° / ${t.roll.toFixed(0)}°`;
    this.els.tAlt.textContent = t.alt.toFixed(1) + " m";
    if (t.armed !== this.armed) {
      // firmware truth if remote disarm
      // don't fight user hold; only sync display of remote flag when not holding
    }
  },

  _controlSnapshot() {
    // Gamepad overrides virtual sticks when active axes move
    const pad = Gamepad.read();
    let thr, yaw, pit, rol;
    if (pad && (Math.abs(pad.throttleAxis) > 0.01 || Math.abs(pad.yaw) > 0.01 ||
                Math.abs(pad.pitch) > 0.01 || Math.abs(pad.roll) > 0.01)) {
      thr = (pad.throttleAxis + 1) / 2;
      yaw = pad.yaw;
      pit = pad.pitch;
      rol = pad.roll;
      this.els.valsLeft.textContent = `T ${(thr * 100) | 0} · Y ${(yaw * 100) | 0}`;
      this.els.valsRight.textContent = `P ${(pit * 100) | 0} · R ${(rol * 100) | 0}`;
    } else {
      thr = this.stickL.throttle;
      yaw = this.stickL.yaw;
      pit = this.stickR.pitch;
      rol = this.stickR.roll;
      this.els.valsLeft.textContent = `T ${Math.round(thr * 100)} · Y ${Math.round(yaw * 100)}`;
      this.els.valsRight.textContent = `P ${Math.round(pit * 100)} · R ${Math.round(rol * 100)}`;
    }

    if (this.estop || this.land) {
      thr = 0;
      pit = 0;
      rol = 0;
      yaw = 0;
    }

    return {
      armed: this.armed && !this.estop,
      land: this.land,
      estop: this.estop,
      mode: this.mode,
      throttle: thr,
      yaw,
      pitch: pit,
      roll: rol,
    };
  },

  async _sendOnce(forceEstop) {
    const s = forceEstop
      ? { armed: false, land: false, estop: true, mode: this.mode, throttle: 0, yaw: 0, pitch: 0, roll: 0 }
      : this._controlSnapshot();
    const bytes = Protocol.packControl(s);
    try {
      await this.ble.writeControl(bytes);
    } catch (err) {
      this.log("写入失败: " + err.message);
    }
  },

  _startSend() {
    this._stopSend();
    const period = Math.max(20, Math.round(1000 / this.sendHz));
    this._timer = setInterval(() => {
      if (!this.ble.connected) return;
      this._sendOnce(false);
    }, period);
  },

  _restartSend() {
    this._startSend();
  },

  _stopSend() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },
};

App.init();
