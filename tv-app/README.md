# ysplive TV · 安卓电视端（Android 4.0+）

ysplive 的电视/手机客户端：连你 NAS 上的 ysplive 服务（默认 `8767` 端口），把频道列表、节目单和直播画面搬到大屏。

- **原生播放**：走系统 `MediaPlayer`（Android 3.0 起原生支持 HLS），**不依赖 hls.js / MSE**，所以 Android 4.0（API 14）的老盒子和老手机也能播。
- **一套包同时装手机和电视**：`LAUNCHER` + `LEANBACK_LAUNCHER` 两个入口，电视桌面能看到图标，手机装上也是同一个 App。
- **遥控器操作**：D-pad（方向键）+ OK + 返回 + 菜单，全部支持；顺带支持 `CHANNEL_UP/DOWN`、`MEDIA_NEXT/PREVIOUS`。
- **触屏操作**：点频道行换台，点画面收起/展开左栏。

## 安装

1. 下载 `ysplive-tv-v1.0.0.apk`（Release 里）
2. 电视：`设置 → 安全 → 允许安装未知来源应用`，用 U 盘 / 当贝市场 / adb 装上
3. 打开后先填 **NAS 地址 + 端口**（如 `192.168.1.10` / `8767`），保存即连

手机同理，直接安装 APK 即可。

## 遥控按键

| 按键 | 作用 |
| --- | --- |
| ↑ / ↓ | 切换频道（选中即换台） |
| ← / → | 上一台 / 下一台（CHANNEL_UP/DOWN、MEDIA_NEXT/PREVIOUS 同效） |
| OK / 确定 | 左栏收起时展开；展开时选中行即播放并收起 |
| 返回 | 收起左栏；再按退出 |
| 菜单 | 打开「连接 NAS」设置，可改地址端口 |

## 它依赖 NAS 上什么

- `http://NAS:8767/api/state` —— 频道列表 + 节目单（ysplive 的网页服务已自带）
- `http://NAS:8767/<slug>.m3u8` —— 主线路；失败自动回退 `http://NAS:8767/api/play.m3u8?ch=<slug>&proxy=1`
- 也就是说：**NAS 上装好 ysplive 并启动**，客户端才有的可连；客户端本身不带频道与代理。

## 构建

不需要 Android Studio / Gradle，一条命令：

```bash
./build.sh
# 产物：ysplive-tv-v1.0.0.apk
```

脚本会自己下载 Android build-tools 33.0.2 与 platform-32（约 120MB，落在 `.sdk/`），流程为
`aapt2 compile → aapt2 link → javac/ECJ → d8 → zipalign → apksigner`。

签名：脚本首次运行会生成 `.keystore.jks`（密码 `ysplive`）。**每个构建机生成的签名不同**，所以换机器构建的新版本要覆盖安装时，需要先卸载旧包；如果要长期「可覆盖升级」的固定签名，需要把同一份 keystore 固化下来（可以让 CI 从仓库 secret 读）。

## 已知限制

- 界面是自绘的简洁版（左侧频道栏 + 底部信息条），没有照搬网页版的三栏浮层；网页版的完整界面仍在 `http://NAS:8767`。
- 节目单来自 NAS 的 EPG 缓存，NAS 上 EPG 还没拉到时只显示频道名。
- 部分频道线路只做 TLS/特殊 HEAD 处理，客户端若播放失败会提示改用网页版。
- Android 4.0 的 `MediaPlayer` 对 HLS 支持有限（TS 分片可用，fMP4 不支持）。

## 版权

上游逻辑 © TMXK（大亨分享）· <https://github.com/tmxk2020/ysp-live>；飞牛/安卓适配 © 火舞狂沙。
