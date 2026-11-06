# PowerInfo — 项目上下文 (AGENTS.md)

本文件记录 PowerInfo 项目的关键上下文，供后续会话恢复使用。本文件由 AI 助手在会话收尾时生成，总结了项目目标、架构、关键决策与验证过的行为。

## 项目目标

一个**几百 KB 以内**的 Android APK，读取设备电池/充电信息（sysfs 节点），并以卡片形式显示在界面上。

- 核心约束：**零第三方依赖**，纯 Java + 系统 WebView + HTML/CSS/JS 前端。
- 成品大小：约 **25 KB**（25463 bytes），远低于几百 KB 目标。
- 包名：`com.powerinfo.app`，版本 1.0.0。
- 界面语言：中文。应用固定暗色主题（不做主题切换）。

## 构建环境

- JDK 21 Temurin：`JAVA_HOME=/d/Scoop/apps/temurin21-jdk/current`
- Gradle 8.14.3（系统安装）
- Android SDK：`ANDROID_HOME=D:\Scoop\apps\android-clt\current`
  - compileSdk 36，minSdk 26，targetSdk 36
  - build-tools 35.0.0 + 36.0.0
- AGP 8.7.3，R8 minify + shrinkResources 开启（release）
- 签名：`debug.keystore`（pass: android），`apksigner`（v2 签名验证通过）

### 构建命令

```bash
cd /d/x/agents/dsh/powerinfo
export JAVA_HOME="/d/Scoop/apps/temurin21-jdk/current"
gradle assembleRelease
# 签名
/d/Scoop/apps/android-clt/current/build-tools/36.0.0/apksigner.bat sign \
  --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out /d/x/agents/dsh/powerinfo.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk
```

### 安装到设备（测试）

```bash
adb -s 192.168.31.64:45555 install -r "D:\\x\\agents\\dsh\\powerinfo.apk"
adb -s 192.168.31.64:45555 shell am force-stop com.powerinfo.app
adb -s 192.168.31.64:45555 shell am start -n com.powerinfo.app/.MainActivity
```

> 注意：测试设备曾为 Redmi Note 7 Pro（已损坏，用户禁止再提此名，只说"设备"）。adb 192.168.31.64:45555 可用，已 root（APatch）。

## 项目结构

```
powerinfo/
├── AGENTS.md                     # 本文件
├── build.gradle                  # 顶层：AGP 8.7.3
├── settings.gradle               # 仓库配置
├── gradle.properties             # jvmargs, useAndroidX=false
├── local.properties              # sdk.dir
├── debug.keystore                # 签名密钥 (pass: android)
└── app/
    ├── build.gradle              # namespace com.powerinfo.app, minify+shrink
    ├── proguard-rules.pro        # 保留 @JavascriptInterface 方法 + WebView
    └── src/main/
        ├── AndroidManifest.xml   # 无权限（root 读取经 su），单 Activity
        ├── assets/
        │   ├── index.html        # 顶栏 + 菜单/设置/关于 + 两卡片容器
        │   ├── style.css         # 固定暗色主题 + 卡片布局
        │   └── app.js            # 前端全权换算 + 3秒轮询
        ├── java/com/powerinfo/app/
        │   ├── MainActivity.java       # WebView + 状态栏偏移 + 桥
        │   ├── PowerInfoBridge.java    # 唯一读取接口 readRaw()
        │   └── RootExecutor.java       # su 解析/执行
        └── res/
            ├── values/  (colors, strings, themes)
            ├── values-night/themes.xml
            ├── drawable/ic_launcher_foreground.xml
            └── mipmap-anydpi-v26/ic_launcher.xml
```

## 架构与关键决策

### 1. 后端职责最小化（用户要求 m00277）
- **后端只暴露一个读取接口** `readRaw()`（`@JavascriptInterface`），返回原始（未换算）sysfs 字符串值。
- **前端全权负责** 显示逻辑、单位换算、格式化。
- 桥对象名：`window.powerinfo`。

### 2. 读取节点与字段

**电池**（`/sys/class/power_supply/battery/`）：
`temp, capacity, current_now, voltage_now, status, technology, health, charge_full_design, charge_full, cycle_count, voltage_max`

**充电/USB**（`/sys/class/power_supply/usb/`）：
`online, quick_charge_type, real_type, voltage_now, input_current_now, voltage_max, voltage_max_design, current_max, pd_active, pd_authentication, pd_current_max, pd_voltage_max, pd_voltage_min, hvdcp3_type`

读取命令（PowerInfoBridge.buildReadCmd）：
```sh
for f in <fields>; do if [ -e "/sys/class/power_supply/<node>/$f" ]; then
  printf '%s=' "$f"; cat "/sys/class/power_supply/<node>/$f" 2>/dev/null; printf '\n';
fi; done
```
- 缺失文件容错：显示 `--`（前端）。
- battery 和 usb 分两次 su 会话读取，避免共享字段名（voltage_now/voltage_max）跨节点冲突。

### 3. Root 执行（RootExecutor.java）
- su 解析顺序：**1) 用户自定义 su 命令**（SharedPreferences `powerinfo`/`su_cmd`）→ **2) 全局候选**（/system/bin/su, /system/xbin/su, /sbin/su, /su/bin/su, /su/su, /vendor/bin/su）→ **3) PATH 上的 "su"**。
- 用 `/system/bin/sh -c` 包装执行 `su -c <command>`，兼容 skroot 方案的 shell 函数 su（无实际文件但可用）。
- **不检查 su 文件存在性**（skroot 的 su 可能无文件）。
- `isRootShell` 用 `su -c id` 判 `uid=0`。
- 找不到 su → 前端显示"需要 root 权限"错误页 + 重试。

### 4. WebView 配置（MainActivity.java）
- `javaScriptEnabled`, `domStorageEnabled`, `allowFileAccess`, `allowContentAccess`。
- **`setUseWideViewPort(false)` + `setLoadWithOverviewMode(false)`**：保证 CSS px = dp 确定性 1:1（否则缩放混乱）。
- 状态栏偏移：`FrameLayout` 容器 `setPadding(0, statusBarH, 0, 0)`，WebView 放容器内。**WebView.setPadding 本身不下移内容**（关键教训）。`statusBarH` 从资源读（设备 81px）。
- 加载 `file:///android_asset/index.html`，`LOAD_NO_CACHE`。

### 5. 前端（app.js）核心逻辑
- **单位换算（前端全权）**：
  - `fmtTemp`：自适应。`|raw|>=1000`→毫℃(/100)，`>=100`→0.1℃(/10)，否则℃。显示 1 位小数。
  - `fmtVoltage`：µV→V，3 位小数。
  - `fmtCapacity`：整数 %。
  - `fmtPower`：`current_now(µA) * voltage_now(µV) / 1e12` → W，3 位。
  - `fmtMah`：µAh→mAh，整数。
  - `fmtLife`：`charge_full/charge_full_design*100`，整数 %。
  - `fmtCurrentMa`：µA→mA，1 位，符号跟随电池状态。
  - `fmtCurrentAbsMa`：绝对值（最大电流/PD最大电流：内核报告负值应显示正数）。
  - `signedVal(raw, status)`：**内核放电用正号**（非标准约定）。Discharging→-abs，Charging/Full→+abs，Unknown→信任内核。
  - `fmtStatus`：Discharging→"未充电"，Charging→"充电中"，Full→"已充满"，Not charging→"未充电"。
  - `fmtOnline`：0→"未连接"，1→"已连接"。
  - `fmtFastcharge`：0/空→"慢速充电"，1→"快速充电"（节点缺失默认慢速）。
  - `fmtHealth`：Good→"良好" 等映射。
  - `fmtRaw`：未知字段显示原值。
- **3 秒轮询** `setInterval(load, 3000)`，**就地更新不闪烁**（首次构建 DOM，之后按 `data-key`/label 匹配更新，不重建卡片，保留"更多"展开状态）。
- `rowMap` 优先 `data-key`（区分重复标签如"快充类型"）。
- 卡片并列：`.cards-row` flex，两卡各 `flex:1 1 0; min-width:0`。

### 6. 卡片布局（用户指定结构）

**电池信息卡**（主区）：电池温度 / 当前电量 / 电池功率 / 电池状态
**电池信息卡**（更多，默认收起）：技术 / 健康 / 电池电压 / 设计容量 / 最大容量 / 剩余寿命 / 充电循环次数 / 最大电压 / 电池电流

**充电信息卡**（主区）：连接状态 / 是否快充 / 高压快充类型 / 协议类型 / 充电电压 / 充电电流 / 充电功率
**充电信息卡**（更多）：最大电压 / 最大设计电压 / 最大电流 / PD激活 / PD认证 / PD最大电流 / PD最大电压 / PD最小电压 / QC激活

**隐藏逻辑**：
- `pd_active <= 0` → 隐藏"PD激活"行 **及所有** pd_ 开头行（PD认证/PD最大电流/PD最大电压/PD最小电压）。
- `hvdcp3_type == 0 或空` → 隐藏"QC激活"行。

### 7. 顶栏（对齐 Shizuku 风格）
- 参考 https://github.com/svier0/Shizuku：标准 toolbar 56px 高，紧贴状态栏，标题垂直居中。
- `.topbar { height: 56px; flex-shrink: 0; padding: 0 16px; align-items: center; }`。
- 用户要求顶栏上下留白对称（已解决）：状态栏下方 56px 顶栏，标题垂直居中。
- 实测 title 中心 162 vs 期望 158，±4px（抗锯齿误差）。

## 前端格式化映射（用户指定）

| 字段 | 格式化 |
|------|--------|
| 连接状态 online | 0→未连接, 1→已连接 |
| 是否快充 fastcharge_mode | 0/空→慢速充电, 1→快速充电 |
| 协议类型 real_type | 原样 (USB_DCP/USB_HVDCP_3/USB_HVDCP_3P5/USB_PD) |
| PD激活 pd_active | >0 才显示 pd_* 行 |
| QC激活 hvdcp3_type | =0/空 隐藏 |

## 用户约束（重要，务必遵守）

1. **不要脑补功能**：用户曾对 AI 擅自加功能发怒。严格按用户明确范围做。
2. **绝口不提"红米Note7Pro"**：只说"设备"（用户怒斥过）。
3. **不要反复截图磨蹭**：直接按几何规则改，不要用截图来回验证视觉细节。
4. **后端只一个读取接口 + 前端全权换算**。
5. **固定暗色主题**，不做主题切换。

## 已验证行为（设备实测）

- 读取正常：电池温度 31.0℃（与 dumpsys 一致）、当前电量、电池功率（符号随状态）、电池状态。
- 充电卡：连接状态、是否快充、高压快充类型、协议类型、充电电压/电流/功率。
- QC 充电（USB_HVDCP_3, pd_active=0）时：PD 五行全部隐藏。
- PD 激活>0 时：pd_* 行显示。
- 轮询 3 秒刷新，就地更新不闪烁，保留"更多"展开状态。
- 顶栏与 Shizuku 对齐，状态栏偏移正确。
- 下拉菜单（⋮→设置/关于）、设置页（自定义 su 命令持久化）、关于弹框均正常。

## 交付物

- 源码：`D:\x\agents\dsh\powerinfo\`
- 成品 APK：`D:\x\agents\dsh\powerinfo.apk`（25 KB，v2 签名通过）

## 后续可能方向（未做，不擅自实现）

- 更多 sysfs 节点字段（用户按需指定才加）。
- 前端换算细节（用户按需指定才改）。
