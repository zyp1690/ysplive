# ysplive TV · 安卓电视端（Android 4.0+，独立版）

**不依赖 NAS** 的独立播放器：频道表、解析、播放全在这台设备上，打开就能用。

- **原生播放**：走系统 `MediaPlayer`（Android 3.0 起原生支持 HLS），不依赖 hls.js / MSE，Android 4.0（API 14）的老盒子也能播。
- **一套包手机 + 电视通用**：`LAUNCHER` + `LEANBACK_LAUNCHER` 双入口。
- **遥控器**：↑↓ 选台、←→ 上下台、OK 开/收左栏、返回收起、菜单进「管理频道」；`CHANNEL_UP/DOWN`、`MEDIA_NEXT/PREVIOUS` 同效。
- **触屏**：点频道换台、点画面收起/展开左栏、长按频道可删除。
- **频道自由管理**：添加单个地址（可带 Referer）、导入 m3u/m3u8 订阅、在线更新频道表、恢复内置频道、清空。

## 安装

1. 下载 `ysplive-tv-v1.0.0.apk`（Release 里）
2. 电视：`设置 → 安全 → 允许安装未知来源应用`，用 U 盘 / 当贝市场 / adb 装上
3. 打开即为频道列表，选中即播

## 频道怎么来（重要）

内置的是**可直连的官方示例源**（CCTV+ 1/2 与浙江广电几条官方 CDN 线路）。中文央视 CCTV-1…17 的官方直播走「央视频」App 的设备签名协议，需要服务器侧做握手，**独立 App 里没有可靠直连办法**——那正是 NAS 版 `ysplive` 在做的事。

所以在独立版里，中文频道靠这两条路：

- 菜单 → **导入 m3u / m3u8 订阅**：粘贴你手上的 IPTV 列表地址，自动解析追加；
- 菜单 → **添加频道**：填名称 + `http(s)://…/xxx.m3u8`，部分源要 Referer 时一并填上。

频道表会存在应用私有目录的 `channels.json`，重装会清空；菜单里的「在线更新频道表」会从
`https://raw.githubusercontent.com/zyp1690/ysplive/main/tv-app/channels.json` 拉最新列表，
这条链接我后续会持续维护可用线路，所以换源不用重装。

## 构建

不需要 Android Studio / Gradle：

```bash
./build.sh          # 产物：ysplive-tv-v1.0.0.apk
```

脚本会自己下 Android build-tools 33.0.2 与 platform-32 到 `.sdk/`，流程
`aapt2 compile → aapt2 link → javac/ECJ → d8 → zipalign → apksigner`。

签名：首次运行生成 `.keystore.jks`（密码 `ysplive`）。**每个构建机签名不同**，换机器构建的包覆盖升级要先卸载旧包。

## 已知限制

- 内置示例源不是中文央视；央视中文频道需自备源（见上）。
- 界面是自绘简洁版（左频道栏 + 底部信息条），没有 EPG 节目单。
- Android 4.0 的 `MediaPlayer` 只支持 TS 分片 HLS，遇到 fMP4 的源播不了。
- 部分 IPTV 源会挑 UA，App 已做「默认 UA → 备用 UA」两次尝试，仍失败会在屏幕上提示。

## 版权

上游逻辑 © TMXK（大亨分享）· <https://github.com/tmxk2020/ysp-live>；飞牛/安卓适配 © 火舞狂沙。
