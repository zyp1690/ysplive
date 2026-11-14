package com.huowu.ysplivetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

/**
 * ysplive 电视端客户端。
 * 说明：只做「连 NAS 的瘦客户端」——频道列表、节目单、播放地址全部取自 NAS 上 ysplive 服务的
 * /api/state 与 /&lt;slug&gt;.m3u8。播放走系统 MediaPlayer（Android 4.0 起原生支持 HLS），
 * 因此不依赖 hls.js / MSE，能在 Android 4.0 及以上（API 14）的老盒子上跑。
 */
public class MainActivity extends Activity {

    private static final int BG = 0xFF08111C;
    private static final int PANEL_BG = 0xE60B1524;
    private static final int GOLD = 0xFFF3C14C;
    private static final int TEAL = 0xFF22C3A6;
    private static final int TEXT = 0xFFE6EDF5;
    private static final int TEXT_DIM = 0xFF8A9BB4;

    private SharedPreferences prefs;
    private String host = "";
    private int port = 8767;

    private FrameLayout root;
    private VideoView video;
    private LinearLayout panel;
    private LinearLayout rowsHost;
    private ScrollView listScroll;
    private TextView infoTitle;
    private TextView infoSub;
    private TextView status;

    private final ArrayList<Channel> channels = new ArrayList<Channel>();
    private final ArrayList<View> rows = new ArrayList<View>();
    private int current = -1;
    private boolean panelOpen = true;
    private boolean fallbackUsed = false;

    private static class Channel {
        String slug;
        String name;
        String group;
        String now;
        String next;
        String url;
        boolean custom;
    }

    // ------------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("ysplive", MODE_PRIVATE);
        host = prefs.getString("host", "");
        port = prefs.getInt("port", 8767);
        buildUi();
        if (host == null || host.length() == 0) {
            showSettings(true);
        } else {
            reload();
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (video != null) {
                video.stopPlayback();
            }
        } catch (Exception ignored) {
        }
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

        video = new VideoView(this);
        video.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        video.setBackgroundColor(Color.BLACK);
        root.addView(video);

        // 左侧频道栏
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

        TextView panelFoot = new TextView(this);
        panelFoot.setText("↑↓ 选台 · ←→ 上下台 · OK 关闭浮层 · 菜单 设置");
        panelFoot.setTextColor(TEXT_DIM);
        panelFoot.setTextSize(10);
        panelFoot.setPadding(dp(4), dp(8), 0, 0);
        panel.addView(panelFoot);

        // 底部信息条
        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(14), dp(10), dp(14), dp(10));
        GradientDrawable infoBg = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0xE6000000, 0x00000000});
        info.setBackgroundDrawable(infoBg);
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

        video.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                setPanelOpen(!panelOpen);
            }
        });

        setContentView(root);
    }

    private String base() {
        return "http://" + host + ":" + port;
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

    // ------------------------------------------------------------------ 数据

    private void reload() {
        showStatus("正在连接 " + base() + " …");
        new LoadTask().execute();
    }

    private class LoadTask extends AsyncTask<Void, Void, String> {
        protected String doInBackground(Void... params) {
            return httpGet(base() + "/api/state");
        }

        protected void onPostExecute(String json) {
            if (json == null || json.length() == 0) {
                showStatus("连不上 " + base() + "\n按「菜单」改地址，或在 NAS 上确认 ysplive 已启动");
                return;
            }
            try {
                parseChannels(json);
            } catch (Exception e) {
                showStatus("解析失败：" + e.getMessage());
                return;
            }
            if (channels.size() == 0) {
                showStatus("没有读到频道，检查 NAS 端 ysplive 的订阅源");
                return;
            }
            showStatus(null);
            buildRows();
            setPanelOpen(true);
            play(0);
        }
    }

    private void parseChannels(String json) throws Exception {
        channels.clear();
        JSONObject o = new JSONObject(json);
        JSONArray builtin = o.optJSONArray("builtin");
        if (builtin != null) {
            for (int i = 0; i < builtin.length(); i++) {
                JSONObject ch = builtin.optJSONObject(i);
                if (ch == null || ch.optBoolean("hidden")) {
                    continue;
                }
                Channel c = new Channel();
                c.slug = ch.optString("slug");
                c.name = ch.optString("name");
                c.group = ch.optString("group");
                JSONObject now = ch.optJSONObject("now");
                if (now != null) {
                    c.now = now.optString("start") + "-" + now.optString("stop") + "  " + now.optString("title");
                }
                JSONObject next = ch.optJSONObject("next");
                if (next != null) {
                    c.next = next.optString("start") + "-" + next.optString("stop") + "  " + next.optString("title");
                }
                channels.add(c);
            }
        }
        JSONArray custom = o.optJSONArray("custom");
        if (custom != null) {
            for (int i = 0; i < custom.length(); i++) {
                JSONObject ch = custom.optJSONObject(i);
                if (ch == null) {
                    continue;
                }
                Channel c = new Channel();
                c.custom = true;
                c.name = ch.optString("name");
                c.group = ch.optString("group");
                c.url = ch.optString("url");
                if (c.url == null || c.url.length() == 0) {
                    continue;
                }
                channels.add(c);
            }
        }
    }

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
            row.setLayoutParams(rowLp);
            row.setBackgroundDrawable(bg(0x00000000, 8));
            row.setFocusable(true);
            row.setFocusableInTouchMode(true);

            TextView name = new TextView(this);
            name.setText((i + 1) + "  " + channels.get(i).name);
            name.setTextColor(TEXT);
            name.setTextSize(15);
            row.addView(name);

            TextView sub = new TextView(this);
            String s = channels.get(i).now;
            sub.setText(s == null ? channels.get(i).group : s);
            sub.setTextColor(TEXT_DIM);
            sub.setTextSize(11);
            sub.setSingleLine(true);
            row.addView(sub);

            row.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    play(index);
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
                TextView name = (TextView) row.getChildAt(0);
                name.setTextColor(on ? 0xFF12233B : TEXT);
            }
        }
    }

    // ------------------------------------------------------------------ 播放

    private void play(int index) {
        if (index < 0 || index >= channels.size()) {
            return;
        }
        current = index;
        fallbackUsed = false;
        highlight();
        Channel c = channels.get(index);
        infoTitle.setText(c.name + (c.now != null ? "    " + c.now : ""));
        String second = c.next != null ? ("稍后：" + c.next) : (c.group == null ? "" : c.group);
        infoSub.setText(second);

        rowsHost.post(new Runnable() {
            public void run() {
                if (current >= 0 && current < rows.size()) {
                    rows.get(current).requestFocus();
                    listScroll.smoothScrollTo(0, rows.get(current).getTop());
                }
            }
        });

        String url = c.custom ? c.url : (base() + "/" + c.slug + ".m3u8");
        startPlayback(url, index);
    }

    private void startPlayback(final String url, final int index) {
        try {
            video.stopPlayback();
        } catch (Exception ignored) {
        }
        video.setVideoURI(Uri.parse(url));
        video.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
            public void onPrepared(MediaPlayer mp) {
                mp.setLooping(false);
                video.start();
            }
        });
        video.setOnErrorListener(new MediaPlayer.OnErrorListener() {
            public boolean onError(MediaPlayer mp, int what, int extra) {
                if (!fallbackUsed && !channels.get(index).custom) {
                    fallbackUsed = true;
                    startPlayback(base() + "/api/play.m3u8?ch=" + channels.get(index).slug + "&proxy=1", index);
                } else {
                    showStatus("线路播放失败（what=" + what + "），手机可改用网页版观看");
                }
                return true;
            }
        });
        video.requestFocus();
    }

    private void playRelative(int delta) {
        if (channels.size() == 0) {
            return;
        }
        int next = current;
        if (next < 0) {
            next = 0;
        } else {
            next = (next + delta + channels.size()) % channels.size();
        }
        setPanelOpen(true);
        play(next);
    }

    private void move(int delta) {
        if (channels.size() == 0) {
            return;
        }
        setPanelOpen(true);
        playRelative(delta);
    }

    // ------------------------------------------------------------------ 按键（遥控 + 键盘）

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP:
                move(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                move(1);
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
                showSettings(false);
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    // ------------------------------------------------------------------ 设置

    private void showSettings(final boolean firstRun) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(10), dp(18), dp(4));

        TextView tip = new TextView(this);
        tip.setText("填 NAS 的地址和 ysplive 端口（默认 8767）");
        tip.setTextColor(0xFF333333);
        tip.setTextSize(12);
        box.addView(tip);

        final EditText hostInput = new EditText(this);
        hostInput.setHint("NAS 地址，如 192.168.1.10 或 nas.local");
        hostInput.setText(host);
        hostInput.setSingleLine(true);
        hostInput.setInputType(InputType.TYPE_CLASS_TEXT);
        box.addView(hostInput);

        final EditText portInput = new EditText(this);
        portInput.setHint("端口，默认 8767");
        portInput.setText(String.valueOf(port));
        portInput.setSingleLine(true);
        portInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        box.addView(portInput);

        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("连接 NAS");
        b.setView(box);
        b.setCancelable(!firstRun);
        b.setPositiveButton("连接", new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface dialog, int which) {
                String h = hostInput.getText().toString().trim();
                if (h.length() == 0) {
                    Toast.makeText(MainActivity.this, "地址不能为空", Toast.LENGTH_SHORT).show();
                    showSettings(firstRun);
                    return;
                }
                int p = port;
                try {
                    p = Integer.parseInt(portInput.getText().toString().trim());
                } catch (Exception ignored) {
                    p = 8767;
                }
                host = h;
                port = p;
                prefs.edit().putString("host", host).putInt("port", port).commit();
                setPanelOpen(true);
                reload();
            }
        });
        if (!firstRun) {
            b.setNegativeButton("取消", null);
        }
        b.show();
    }

    // ------------------------------------------------------------------ 网络

    private String httpGet(String url) {
        HttpURLConnection conn = null;
        InputStream in = null;
        try {
            URL u = new URL(url);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code != 200) {
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
