package com.huowu.ysplivetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;

import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;


import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * ysplive TV 独立版：不依赖 NAS，自己播放直播源。
 *
 * - 内置一份频道表（assets/channels.json），首次启动复制到应用私有目录
 * - 频道可增删改：添加单个频道地址 / 导入 m3u 订阅 / 在线更新频道表 / 恢复默认
 * - 播放用原生 MediaPlayer（Android 4.0 起支持 HLS），支持 per-channel UA/Referer
 * - 遥控器（D-pad / OK / 返回 / 菜单）与触摸（点画面收起左栏、点频道换台）都支持
 */
public class MainActivity extends Activity {

    private static final int BG = 0xFF08111C;
    private static final int PANEL_BG = 0xE60B1524;
    private static final int GOLD = 0xFFF3C14C;
    private static final int TEAL = 0xFF22C3A6;
    private static final int TEXT = 0xFFE6EDF5;
    private static final int TEXT_DIM = 0xFF8A9BB4;

    /** 在线更新的频道表地址（改这里即可换源） */
    private static final String REMOTE_URL =
            "https://raw.githubusercontent.com/zyp1690/ysplive/main/tv-app/channels.json";

    private SharedPreferences prefs;
    private FrameLayout root;
    private SurfaceView surface;
    private MediaPlayer player;
    private LinearLayout panel;
    private LinearLayout rowsHost;
    private ScrollView listScroll;
    private TextView infoTitle;
    private TextView infoSub;
    private TextView status;

    private final ArrayList<Chan> channels = new ArrayList<Chan>();
    private final ArrayList<View> rows = new ArrayList<View>();
    private int current = -1;
    private boolean panelOpen = true;
    private boolean preparing = false;
    private int retryCount = 0;

    private static class Chan {
        String name = "";
        String group = "";
        String url = "";
        String referer = "";
        String ua = "";

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("name", name);
                o.put("group", group);
                o.put("url", url);
                if (referer.length() > 0) {
                    o.put("referer", referer);
                }
                if (ua.length() > 0) {
                    o.put("ua", ua);
                }
            } catch (Exception ignored) {
            }
            return o;
        }

        static Chan fromJson(JSONObject o) {
            Chan c = new Chan();
            c.name = o.optString("name", "").trim();
            c.group = o.optString("group", "").trim();
            c.url = o.optString("url", "").trim();
            c.referer = o.optString("referer", "").trim();
            c.ua = o.optString("ua", "").trim();
            return c;
        }
    }

    // ------------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        prefs = getSharedPreferences("ysplive", MODE_PRIVATE);
        buildUi();
        loadChannels();
        if (channels.size() == 0) {
            showStatus("还没有频道\n按「菜单」→ 导入 m3u 订阅、添加频道地址");
        } else {
            buildRows();
            play(0);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        releasePlayer();
    }

    @Override
    protected void onDestroy() {
        releasePlayer();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ 界面

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private GradientDrawable bg(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radius));
        return d;
    }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        surface = new SurfaceView(this);
        surface.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        surface.getHolder().addCallback(new SurfaceHolder.Callback() {
            public void surfaceCreated(SurfaceHolder holder) {
                if (pendingUrl != null) {
                    openUrl(pendingUrl, pendingHeaders, pendingName);
                }
            }

            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            }

            public void surfaceDestroyed(SurfaceHolder holder) {
            }
        });
        surface.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                setPanelOpen(!panelOpen);
            }
        });
        root.addView(surface);

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(PANEL_BG);
        panel.setPadding(dp(10), dp(12), dp(10), dp(8));
        FrameLayout.LayoutParams panelLp = new FrameLayout.LayoutParams(dp(288),
                ViewGroup.LayoutParams.MATCH_PARENT);
        panelLp.gravity = Gravity.LEFT;
        root.addView(panel, panelLp);

        TextView panelTitle = new TextView(this);
        panelTitle.setText("频道列表");
        panelTitle.setTextColor(GOLD);
        panelTitle.setTextSize(17);
        panelTitle.setPadding(dp(4), 0, 0, dp(8));
        panel.addView(panelTitle);

        listScroll = new ScrollView(this);
        listScroll.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        rowsHost = new LinearLayout(this);
        rowsHost.setOrientation(LinearLayout.VERTICAL);
        listScroll.addView(rowsHost);
        panel.addView(listScroll);

        TextView foot = new TextView(this);
        foot.setText("↑↓ 选台 · ←→ 上下台 · OK 关闭 · 菜单 管理频道");
        foot.setTextColor(TEXT_DIM);
        foot.setTextSize(10);
        foot.setPadding(dp(4), dp(8), 0, 0);
        panel.addView(foot);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(14), dp(10), dp(14), dp(10));
        info.setBackgroundDrawable(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0xE6000000, 0x00000000}));
        FrameLayout.LayoutParams infoLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        infoLp.gravity = Gravity.BOTTOM;
        root.addView(info, infoLp);

        infoTitle = new TextView(this);
        infoTitle.setTextColor(TEXT);
        infoTitle.setTextSize(16);
        info.addView(infoTitle);

        infoSub = new TextView(this);
        infoSub.setTextColor(TEXT_DIM);
        infoSub.setTextSize(12);
        infoSub.setPadding(0, dp(2), 0, 0);
        info.addView(infoSub);

        status = new TextView(this);
        status.setTextColor(TEAL);
        status.setTextSize(14);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(16), dp(10), dp(16), dp(10));
        status.setBackgroundDrawable(bg(0xE60B1524, 10));
        FrameLayout.LayoutParams stLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stLp.gravity = Gravity.CENTER;
        status.setVisibility(View.GONE);
        root.addView(status, stLp);

        setContentView(root);
    }

    private void setPanelOpen(boolean open) {
        panelOpen = open;
        panel.setVisibility(open ? View.VISIBLE : View.GONE);
    }

    private void showStatus(String text) {
        if (text == null || text.length() == 0) {
            status.setVisibility(View.GONE);
        } else {
            status.setText(text);
            status.setVisibility(View.VISIBLE);
        }
    }

    // ------------------------------------------------------------------ 频道表存储

    private File channelsFile() {
        return new File(getFilesDir(), "channels.json");
    }

    private void loadChannels() {
        channels.clear();
        String text = null;
        File f = channelsFile();
        if (f.exists()) {
            text = readFile(f);
        }
        if (text == null || text.trim().length() == 0) {
            text = readAsset("channels.json");
        }
        if (text != null) {
            parseChannelJson(text, true);
        }
        if (!f.exists()) {
            saveChannels();
        }
    }

    /** replace=true 表示清空后写入；false 表示追加（去重） */
    private int parseChannelJson(String text, boolean replace) {
        int added = 0;
        try {
            JSONArray arr;
            String t = text.trim();
            if (t.startsWith("{")) {
                JSONObject o = new JSONObject(t);
                arr = o.optJSONArray("channels");
            } else {
                arr = new JSONArray(t);
            }
            if (arr == null) {
                return 0;
            }
            if (replace) {
                channels.clear();
            }
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) {
                    continue;
                }
                Chan c = Chan.fromJson(o);
                if (c.name.length() == 0 || c.url.length() == 0) {
                    continue;
                }
                if (findIndexByUrl(c.url) >= 0) {
                    continue;
                }
                channels.add(c);
                added++;
            }
        } catch (Exception e) {
            showStatus("频道表格式不对：" + e.getMessage());
        }
        return added;
    }

    private int findIndexByUrl(String url) {
        for (int i = 0; i < channels.size(); i++) {
            if (channels.get(i).url.equals(url)) {
                return i;
            }
        }
        return -1;
    }

    private void saveChannels() {
        JSONArray arr = new JSONArray();
        for (int i = 0; i < channels.size(); i++) {
            arr.put(channels.get(i).toJson());
        }
        try {
            FileOutputStream out = new FileOutputStream(channelsFile());
            out.write(arr.toString().getBytes("UTF-8"));
            out.close();
        } catch (Exception e) {
            showStatus("保存失败：" + e.getMessage());
        }
    }

    private String readFile(File f) {
        try {
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            in.close();
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private String readAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            in.close();
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ 频道列表 UI

    private void buildRows() {
        rowsHost.removeAllViews();
        rows.clear();
        for (int i = 0; i < channels.size(); i++) {
            final int index = i;
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(10), dp(8), dp(8), dp(8));
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rowLp.bottomMargin = dp(4);
            row.setBackgroundDrawable(bg(0x00000000, 8));
            row.setFocusable(true);
            row.setFocusableInTouchMode(true);

            TextView name = new TextView(this);
            name.setText((i + 1) + "  " + channels.get(i).name);
            name.setTextColor(TEXT);
            name.setTextSize(15);
            row.addView(name);

            TextView sub = new TextView(this);
            sub.setText(channels.get(i).group.length() > 0 ? channels.get(i).group : "未分组");
            sub.setTextColor(TEXT_DIM);
            sub.setTextSize(11);
            sub.setSingleLine(true);
            row.addView(sub);

            row.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    play(index);
                }
            });
            row.setOnLongClickListener(new View.OnLongClickListener() {
                public boolean onLongClick(View v) {
                    confirmDelete(index);
                    return true;
                }
            });
            row.setOnFocusChangeListener(new View.OnFocusChangeListener() {
                public void onFocusChange(View v, boolean hasFocus) {
                    v.setBackgroundDrawable(bg(hasFocus ? 0x33F3C14C : 0x00000000, 8));
                }
            });
            rowsHost.addView(row, rowLp);
            rows.add(row);
        }
        highlight();
    }

    private void highlight() {
        for (int i = 0; i < rows.size(); i++) {
            boolean on = (i == current);
            rows.get(i).setBackgroundDrawable(bg(on ? GOLD : 0x00000000, 8));
            LinearLayout row = (LinearLayout) rows.get(i);
            if (row.getChildCount() > 0) {
                ((TextView) row.getChildAt(0)).setTextColor(on ? 0xFF12233B : TEXT);
            }
        }
    }

    private void confirmDelete(final int index) {
        if (index < 0 || index >= channels.size()) {
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("删除频道")
                .setMessage(channels.get(index).name)
                .setPositiveButton("删除", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        channels.remove(index);
                        saveChannels();
                        current = -1;
                        buildRows();
                        if (channels.size() > 0) {
                            play(0);
                        } else {
                            releasePlayer();
                            infoTitle.setText("");
                            infoSub.setText("");
                            showStatus("频道已清空，按「菜单」添加");
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    // ------------------------------------------------------------------ 播放

    private String pendingUrl;
    private Map<String, String> pendingHeaders;
    private String pendingName;

    private void play(int index) {
        if (index < 0 || index >= channels.size()) {
            return;
        }
        current = index;
        retryCount = 0;
        highlight();
        Chan c = channels.get(index);
        infoTitle.setText(c.name);
        infoSub.setText(c.group.length() > 0 ? c.group : "自定义频道");
        rowsHost.post(new Runnable() {
            public void run() {
                if (current >= 0 && current < rows.size()) {
                    rows.get(current).requestFocus();
                    listScroll.smoothScrollTo(0, rows.get(current).getTop());
                }
            }
        });
        Map<String, String> headers = new HashMap<String, String>();
        if (c.ua.length() > 0) {
            headers.put("User-Agent", c.ua);
        } else {
            headers.put("User-Agent", "Mozilla/5.0 (Linux; Android 9; SmartTV) AppleWebKit/537.36");
        }
        if (c.referer.length() > 0) {
            headers.put("Referer", c.referer);
        }
        startStream(c.url, headers, c.name);
    }

    private void startStream(final String url, final Map<String, String> headers, final String name) {
        showStatus("正在连接…");
        if (surface.getHolder().getSurface() == null) {
            pendingUrl = url;
            pendingHeaders = headers;
            pendingName = name;
            return;
        }
        pendingUrl = null;
        openUrl(url, headers, name);
    }

    private void openUrl(String url, Map<String, String> headers, String name) {
        releasePlayer();
        try {
            player = new MediaPlayer();
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setDisplay(surface.getHolder());
            player.setDataSource(this, Uri.parse(url), headers);
            preparing = true;
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                public void onPrepared(MediaPlayer mp) {
                    preparing = false;
                    showStatus(null);
                    mp.start();
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                public boolean onError(MediaPlayer mp, int what, int extra) {
                    preparing = false;
                    if (retryCount == 0) {
                        retryCount = 1;
                        // 换默认 UA 再试一次（很多源卡 UA / 卡 Referer）
                        Map<String, String> h = new HashMap<String, String>();
                        h.put("User-Agent", "Mozilla/5.0 (Linux; Android 6.0; Nexus 5) AppleWebKit/537.36");
                        if (channels.get(current).referer.length() > 0) {
                            h.put("Referer", channels.get(current).referer);
                        }
                        openUrl(channels.get(current).url, h, channels.get(current).name);
                        return true;
                    }
                    showStatus("这条线路播不了（" + what + "/" + extra + "）\n长按该频道可删除，按「菜单」换源");
                    return true;
                }
            });
            player.prepareAsync();
        } catch (Exception e) {
            preparing = false;
            showStatus("打开失败：" + e.getMessage());
        }
    }

    private void releasePlayer() {
        if (player != null) {
            try {
                player.setOnErrorListener(null);
                player.reset();
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
    }

    private void playRelative(int delta) {
        if (channels.size() == 0) {
            return;
        }
        int next = current < 0 ? 0 : (current + delta + channels.size()) % channels.size();
        setPanelOpen(true);
        play(next);
    }

    // ------------------------------------------------------------------ 按键

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP:
                playRelative(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                playRelative(1);
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                playRelative(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                playRelative(1);
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
                if (!panelOpen) {
                    setPanelOpen(true);
                    play(current);
                    return true;
                }
                return false;
            case KeyEvent.KEYCODE_BACK:
                if (panelOpen) {
                    setPanelOpen(false);
                    return true;
                }
                return super.onKeyDown(keyCode, event);
            case KeyEvent.KEYCODE_MENU:
                showManageDialog();
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    // ------------------------------------------------------------------ 管理频道

    private void showManageDialog() {
        String[] items = new String[]{
                "添加频道（名称 + 地址）",
                "导入 m3u / m3u8 订阅",
                "在线更新频道表",
                "恢复内置频道",
                "清空全部频道"
        };
        new AlertDialog.Builder(this)
                .setTitle("管理频道（共 " + channels.size() + " 个）")
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) {
                            addChannelDialog();
                        } else if (which == 1) {
                            importDialog();
                        } else if (which == 2) {
                            updateFromRemote();
                        } else if (which == 3) {
                            resetDefaults();
                        } else {
                            clearAll();
                        }
                    }
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    private void addChannelDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(8), dp(18), dp(0));

        final EditText name = new EditText(this);
        name.setHint("频道名称，如 CCTV-1");
        name.setSingleLine(true);
        box.addView(name);

        final EditText url = new EditText(this);
        url.setHint("播放地址，http(s)://.../xxx.m3u8");
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT);
        box.addView(url);

        final EditText referer = new EditText(this);
        referer.setHint("Referer（可选，部分源需要）");
        referer.setSingleLine(true);
        box.addView(referer);

        new AlertDialog.Builder(this)
                .setTitle("添加频道")
                .setView(box)
                .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        Chan c = new Chan();
                        c.name = name.getText().toString().trim();
                        c.url = url.getText().toString().trim();
                        c.referer = referer.getText().toString().trim();
                        c.group = "自定义";
                        if (c.name.length() == 0 || !c.url.startsWith("http")) {
                            Toast.makeText(MainActivity.this, "名称和 http 地址都不能空", Toast.LENGTH_SHORT).show();
                            return;
                        }
                        channels.add(c);
                        saveChannels();
                        buildRows();
                        play(channels.size() - 1);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void importDialog() {
        final EditText input = new EditText(this);
        input.setHint("m3u / m3u8 订阅地址");
        input.setSingleLine(true);
        LinearLayout box = new LinearLayout(this);
        box.setPadding(dp(18), dp(8), dp(18), dp(0));
        box.addView(input);

        new AlertDialog.Builder(this)
                .setTitle("导入订阅")
                .setMessage("粘贴一个 m3u/m3u8 列表地址，会自动解析频道并追加。")
                .setView(box)
                .setPositiveButton("导入", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        String u = input.getText().toString().trim();
                        if (!u.startsWith("http")) {
                            return;
                        }
                        showStatus("正在下载订阅…");
                        new Thread(new Runnable() {
                            public void run() {
                                final String body = httpGet(u, null);
                                runOnUiThread(new Runnable() {
                                    public void run() {
                                        if (body == null) {
                                            showStatus("订阅下载失败，检查地址或网络");
                                            return;
                                        }
                                        int n = parseM3u(body);
                                        saveChannels();
                                        buildRows();
                                        showStatus(n > 0 ? ("新增 " + n + " 个频道") : "没解析到频道（列表里可能没有 #EXTINF）");
                                        if (channels.size() > 0 && current < 0) {
                                            play(0);
                                        }
                                    }
                                });
                            }
                        }).start();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** 解析 m3u：支持 #EXTINF 列表，也支持 “名称,地址” 每行一条的 txt 列表 */
    private int parseM3u(String body) {
        int added = 0;
        String pendingName = null;
        String pendingGroup = "";
        String[] lines = body.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.length() == 0 || line.startsWith("#EXTM3U")) {
                continue;
            }
            if (line.startsWith("#EXTINF")) {
                int comma = line.lastIndexOf(',');
                pendingName = comma >= 0 && comma + 1 < line.length() ? line.substring(comma + 1).trim() : "未命名";
                int g = line.indexOf("group-title=\"");
                if (g >= 0) {
                    int e = line.indexOf('"', g + 13);
                    if (e > g) {
                        pendingGroup = line.substring(g + 13, e);
                    }
                } else {
                    pendingGroup = "订阅";
                }
                continue;
            }
            if (line.startsWith("#")) {
                continue;
            }
            String url = line;
            String name = pendingName;
            if (url.indexOf(',') > 0 && (url.indexOf("http") < 0 || url.indexOf(',') < url.indexOf("http"))) {
                int comma = url.indexOf(',');
                if (name == null) {
                    name = url.substring(0, comma).trim();
                }
                url = url.substring(comma + 1).trim();
            }
            if (!url.startsWith("http")) {
                pendingName = null;
                continue;
            }
            Chan c = new Chan();
            c.name = name == null ? ("频道" + (channels.size() + 1)) : name;
            c.group = pendingGroup.length() > 0 ? pendingGroup : "订阅";
            c.url = url;
            if (findIndexByUrl(c.url) < 0) {
                channels.add(c);
                added++;
            }
            pendingName = null;
        }
        return added;
    }

    private void updateFromRemote() {
        showStatus("正在更新频道表…");
        new Thread(new Runnable() {
            public void run() {
                final String body = httpGet(REMOTE_URL, null);
                runOnUiThread(new Runnable() {
                    public void run() {
                        if (body == null) {
                            showStatus("更新失败：网络不通或地址失效\n" + REMOTE_URL);
                            return;
                        }
                        int n = parseChannelJson(body, false);
                        saveChannels();
                        buildRows();
                        showStatus(n > 0 ? ("新增 " + n + " 个频道") : "频道表已是最新");
                        if (current < 0 && channels.size() > 0) {
                            play(0);
                        }
                    }
                });
            }
        }).start();
    }

    private void resetDefaults() {
        String text = readAsset("channels.json");
        if (text == null) {
            return;
        }
        parseChannelJson(text, true);
        saveChannels();
        current = -1;
        buildRows();
        if (channels.size() > 0) {
            play(0);
        }
        showStatus("已恢复内置频道");
    }

    private void clearAll() {
        new AlertDialog.Builder(this)
                .setTitle("清空全部频道？")
                .setMessage("清空后可以从菜单重新导入订阅。")
                .setPositiveButton("清空", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        channels.clear();
                        saveChannels();
                        releasePlayer();
                        current = -1;
                        buildRows();
                        infoTitle.setText("");
                        infoSub.setText("");
                        showStatus("已清空，按「菜单」添加频道");
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    // ------------------------------------------------------------------ 网络

    private String httpGet(String url, Map<String, String> headers) {
        HttpURLConnection conn = null;
        InputStream in = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 9; SmartTV)");
            if (headers != null) {
                for (String k : headers.keySet()) {
                    conn.setRequestProperty(k, headers.get(k));
                }
            }
            if (conn.getResponseCode() != 200) {
                return null;
            }
            in = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            try {
                if (in != null) {
                    in.close();
                }
            } catch (Exception ignored) {
            }
            if (conn != null) {
                conn.disconnect();
            }
        }
    }
}
