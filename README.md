# ESP32 无人机蓝牙遥控 · 阶段 1 框架

实验室自用、安卓 Chrome 网页遥控，**先不装桨**做通信与电机验证。

## 目录

```
index.html          # 网页入口
styles.css          # UI 样式（CSS 变量可调）
app.js              # 控制逻辑（协议 / 摇杆 / BLE 分段）
esp32/drone_ble_phase1/
  drone_ble_phase1.ino   # ESP32 BLE 外设 + 四路 PWM
```

## 浏览器要求

- **Chrome / Edge**（安卓或桌面）
- 页面需在 **HTTPS 或 localhost** 下才能用 Web Bluetooth  
  - 本地开发：`python -m http.server` 后用局域网 HTTPS 或 Chrome 打开 `http://localhost:8000`（桌面调试即可）  
  - 安卓手机需可通过局域网访问的 HTTPS（如 `npx serve` + 自签或内网穿透）或 Chrome 的实验性不安全来源（不推荐）

## 安全

1. 阶段 1 **禁止安装螺旋桨**  
2. 解锁用长按 0.8s，上锁一点即锁  
3. ESP32 侧 **500ms 无包自动停桨**（改 `LINK_TIMEOUT_MS`）  
4. 紧急停机按钮会立刻油门清零

## 协议（两端一致）

控制特征写入 8 字节：

| 字节 | 含义 |
|------|------|
| 0 | 魔数 `0xA5` |
| 1 | 版本 `0x01` |
| 2 | 标志：bit0 解锁，bit1 降落，bit2 急停，bit3 模式 |
| 3 | 油门 0..255 |
| 4 | 偏航 0..255（128 居中） |
| 5 | 俯仰 0..255（128 居中） |
| 6 | 横滚 0..255（128 居中） |
| 7 | 校验和 = 字节0..6 之和 & 0xFF |

遥测 notify 8 字节：`电量% | pitch(i16/100) | roll(i16/100) | 高度cm(u16) | flags`（阶段 1 电量为占位）

UUID：

- Service `0000ff01-0000-1000-8000-00805f9b34fb`
- Control `...ff02-...` WRITE
- Telemetry `...ff03-...` NOTIFY

改 UUID 时两边 `CONFIG` / `SERVICE_UUID` 一起改。

## 烧录 ESP32

1. Arduino IDE 或 PlatformIO  
2. 安装库 **NimBLE-Arduino**  
3. 板子选 ESP32 Dev Module，打开 `drone_ble_phase1.ino` 烧录  
4. 串口 115200 可见广播日志  

电机脚默认 `18/19/21/22`，电调 1000–2000µs @50Hz — 按接线在 `.ino` 的 `[TUNE]` 处改。

## 手机使用

1. ESP32 上电，确认设备名 `ESP32-Drone`  
2. 手机 Chrome 打开网页 →「连接蓝牙」→ 选设备  
3. 长按「长按解锁」→ 推左摇杆油门（无桨应看到电调/电机响应）  
4. 断电或点「紧急停机」

## 后续怎么改（框架已留口）

| 目标 | 改哪里 |
|------|--------|
| 摇杆行程/死区/发送频率 | `app.js` → `CONFIG` |
| 协议字段扩展 | `Protocol.packControl` + `.ino` 解析 |
| 电机混控/机架 | `.ino` → `applyMix` |
| 失联超时、电调行程 | `.ino` → `[TUNE]` 常量 |
| UI 颜色、摇杆大小 | `styles.css` → `:root` |
| 阶段 2 稳定 | `.ino` 增加 MPU6050 + PID，网页 mode 位沿用 |
| 换成小程序/App | 复用同一 BLE 协议，重写 UI 层 |

## 阶段 2 预留

- 硬件：MPU6050（I2C）  
- 固件：姿态解算 + PID，把网页的 pitch/roll/yaw 变成目标角  
- 电量 ADC、真实遥测替换占位字节  
