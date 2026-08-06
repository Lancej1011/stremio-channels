package io.headend.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(9, 11, 15);
    private static final int PANEL = Color.rgb(16, 19, 24);
    private static final int PANEL_2 = Color.rgb(21, 25, 34);
    private static final int LINE = Color.rgb(48, 55, 67);
    private static final int TEXT = Color.rgb(241, 243, 247);
    private static final int DIM = Color.rgb(146, 154, 169);
    private static final int AMBER = Color.rgb(245, 181, 68);
    private static final int GREEN = Color.rgb(79, 209, 139);
    private static final String PREFS = "headend";
    private static final String PREF_URL = "viewer_url";
    private static final String PREF_CHANNEL = "last_channel";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final List<GuideChannel> channels = new ArrayList<>();
    private final Runnable guideRefresh = () -> loadGuide(false);
    private final Runnable boundaryRetune = this::retuneCurrent;

    private ExoPlayer player;
    private PlayerView playerView;
    private FrameLayout guidePanel;
    private LinearLayout guideRows;
    private TextView channelLabel;
    private TextView titleLabel;
    private TextView nextLabel;
    private TextView modeLabel;
    private LinearLayout statusPanel;
    private TextView statusTitle;
    private TextView statusDetail;
    private ProgressBar statusProgress;
    private Button statusAction;
    private String serverRoot;
    private String viewerUrl;
    private String currentChannelId;
    private String fallbackHlsUrl;
    private boolean playingDirect;
    private int tuneGeneration;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        buildInterface();
        buildPlayer();

        viewerUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_URL, null);
        if (viewerUrl == null) {
            showServerDialog(true);
        } else {
            connect(viewerUrl);
        }
    }

    private void buildInterface() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom()
            );
            return insets;
        });
        setContentView(root);

        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
        root.addView(playerView, match());

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(16), dp(8), dp(10), dp(8));
        top.setBackgroundColor(Color.argb(220, 9, 11, 15));
        TextView brand = label("HEADEND", 13, AMBER, true);
        brand.setSingleLine(true);
        top.addView(brand, new LinearLayout.LayoutParams(dp(96), dp(48)));
        channelLabel = label("Not connected", 15, TEXT, true);
        channelLabel.setSingleLine(true);
        channelLabel.setEllipsize(TextUtils.TruncateAt.END);
        top.addView(channelLabel, new LinearLayout.LayoutParams(0, dp(48), 1));
        modeLabel = label("", 11, GREEN, true);
        modeLabel.setGravity(Gravity.CENTER);
        top.addView(modeLabel, new LinearLayout.LayoutParams(dp(76), dp(40)));
        Button settings = button("Server", false);
        settings.setOnClickListener(view -> showServerDialog(false));
        top.addView(settings, new LinearLayout.LayoutParams(dp(82), dp(44)));
        FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(-1, dp(64), Gravity.TOP);
        root.addView(top, topParams);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(16), dp(10), dp(16), dp(14));
        info.setBackgroundColor(Color.argb(225, 9, 11, 15));
        titleLabel = label("Choose a channel", 21, TEXT, true);
        nextLabel = label("", 13, DIM, false);
        info.addView(titleLabel, new LinearLayout.LayoutParams(-1, dp(34)));
        info.addView(nextLabel, new LinearLayout.LayoutParams(-1, dp(28)));
        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        Button previous = button("− CH", false);
        Button guide = button("Guide", true);
        Button next = button("CH +", false);
        previous.setOnClickListener(view -> surf(-1));
        guide.setOnClickListener(view -> toggleGuide());
        next.setOnClickListener(view -> surf(1));
        controls.addView(previous, new LinearLayout.LayoutParams(dp(88), dp(46)));
        LinearLayout.LayoutParams guideParams = new LinearLayout.LayoutParams(dp(110), dp(46));
        guideParams.setMargins(dp(8), 0, dp(8), 0);
        controls.addView(guide, guideParams);
        controls.addView(next, new LinearLayout.LayoutParams(dp(88), dp(46)));
        info.addView(controls, new LinearLayout.LayoutParams(-1, dp(50)));
        FrameLayout.LayoutParams infoParams = new FrameLayout.LayoutParams(-1, dp(142), Gravity.BOTTOM);
        root.addView(info, infoParams);

        buildGuide(root);
        buildStatus(root);
    }

    private void buildGuide(FrameLayout root) {
        guidePanel = new FrameLayout(this);
        guidePanel.setBackgroundColor(Color.argb(250, 9, 11, 15));
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(12), dp(8), dp(12), dp(12));
        guidePanel.addView(body, match());

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView heading = label("Program Guide", 20, TEXT, true);
        header.addView(heading, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button refresh = button("Refresh", false);
        refresh.setOnClickListener(view -> loadGuide(true));
        Button close = button("Close", false);
        close.setOnClickListener(view -> guidePanel.setVisibility(View.GONE));
        header.addView(refresh, new LinearLayout.LayoutParams(dp(92), dp(44)));
        LinearLayout.LayoutParams closeParams = new LinearLayout.LayoutParams(dp(82), dp(44));
        closeParams.setMargins(dp(8), 0, 0, 0);
        header.addView(close, closeParams);
        body.addView(header, new LinearLayout.LayoutParams(-1, dp(56)));

        ScrollView scroll = new ScrollView(this);
        guideRows = new LinearLayout(this);
        guideRows.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(guideRows, new ScrollView.LayoutParams(-1, -2));
        body.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, dp(470), Gravity.BOTTOM);
        root.addView(guidePanel, params);
        guidePanel.setVisibility(View.GONE);
    }

    private void buildStatus(FrameLayout root) {
        statusPanel = new LinearLayout(this);
        statusPanel.setOrientation(LinearLayout.VERTICAL);
        statusPanel.setGravity(Gravity.CENTER);
        statusPanel.setPadding(dp(28), dp(24), dp(28), dp(24));
        statusPanel.setBackground(rounded(PANEL, LINE, 12));
        statusProgress = new ProgressBar(this);
        statusTitle = label("Connecting", 20, TEXT, true);
        statusTitle.setGravity(Gravity.CENTER);
        statusDetail = label("Enter your private Headend Watch URL.", 14, DIM, false);
        statusDetail.setGravity(Gravity.CENTER);
        statusPanel.addView(statusProgress, new LinearLayout.LayoutParams(dp(42), dp(42)));
        statusPanel.addView(statusTitle, new LinearLayout.LayoutParams(-1, dp(48)));
        statusPanel.addView(statusDetail, new LinearLayout.LayoutParams(-1, dp(64)));
        statusAction = button("Change server", true);
        statusAction.setOnClickListener(view -> showServerDialog(false));
        statusPanel.addView(statusAction, new LinearLayout.LayoutParams(dp(170), dp(46)));
        int availableWidth = getResources().getDisplayMetrics().widthPixels - dp(32);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            Math.min(dp(440), availableWidth), dp(246), Gravity.CENTER
        );
        root.addView(statusPanel, params);
    }

    private void buildPlayer() {
        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override public void onPlayerError(PlaybackException error) {
                if (playingDirect && fallbackHlsUrl != null) {
                    Toast.makeText(MainActivity.this, "Direct play failed; switching to Headend HLS", Toast.LENGTH_LONG).show();
                    playHls(fallbackHlsUrl);
                } else {
                    showStatus("Playback unavailable", error.getErrorCodeName(), false);
                    handler.postDelayed(boundaryRetune, 3000);
                }
            }

            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) hideStatus();
                if (state == Player.STATE_ENDED && currentChannelId != null) tune(currentChannelId);
            }
        });
    }

    private void connect(String entered) {
        try {
            serverRoot = HeadendUrl.root(entered);
            viewerUrl = entered.trim();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_URL, viewerUrl).apply();
            showStatus("Connecting to Headend", serverRoot, true);
            loadGuide(true);
        } catch (IllegalArgumentException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
            showServerDialog(true);
        }
    }

    private void showServerDialog(boolean required) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("https://server.ts.net/<token>/watch");
        input.setText(viewerUrl == null ? "" : viewerUrl);
        int pad = dp(20);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, dp(6), pad, 0);
        wrap.addView(input, match());
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("Headend server")
            .setMessage("Paste the private Watch URL shown in the local Headend admin interface. The debrid key stays on your server.")
            .setView(wrap)
            .setPositiveButton("Connect", null)
            .setNegativeButton(required ? "Exit" : "Cancel", (box, which) -> { if (required) finish(); })
            .create();
        dialog.setOnShowListener(value -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                HeadendUrl.root(input.getText().toString());
                dialog.dismiss();
                connect(input.getText().toString());
            } catch (IllegalArgumentException error) {
                input.setError(error.getMessage());
            }
        }));
        dialog.setCancelable(!required);
        dialog.show();
    }

    private void loadGuide(boolean foreground) {
        if (serverRoot == null) return;
        handler.removeCallbacks(guideRefresh);
        if (foreground) showStatus("Loading guide", "Reading the Headend schedule…", true);
        String url = HeadendUrl.endpoint(serverRoot, "viewer/guide.json?hours=6");
        network.execute(() -> {
            try {
                JSONObject json = getJson(url);
                List<GuideChannel> loaded = parseGuide(json);
                runOnUiThread(() -> {
                    channels.clear();
                    channels.addAll(loaded);
                    renderGuide();
                    handler.postDelayed(guideRefresh, 30_000);
                    if (channels.isEmpty()) {
                        showStatus("No channels", "Create channels in the Headend admin interface first.", false);
                        return;
                    }
                    if (currentChannelId == null) {
                        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_CHANNEL, null);
                        GuideChannel first = findChannel(saved);
                        tune(first != null ? first.id : channels.get(0).id);
                    } else if (foreground) {
                        hideStatus();
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    showStatus("Cannot reach Headend", readable(error), false);
                    handler.postDelayed(guideRefresh, 5000);
                });
            }
        });
    }

    private List<GuideChannel> parseGuide(JSONObject json) {
        List<GuideChannel> result = new ArrayList<>();
        JSONArray source = json.optJSONArray("channels");
        if (source == null) return result;
        for (int i = 0; i < source.length(); i++) {
            JSONObject channel = source.optJSONObject(i);
            if (channel == null) continue;
            GuideChannel item = new GuideChannel(channel.optString("id"), channel.optString("name"));
            JSONArray programs = channel.optJSONArray("programs");
            if (programs != null) for (int p = 0; p < programs.length(); p++) {
                JSONObject program = programs.optJSONObject(p);
                if (program != null) item.programs.add(new GuideProgram(
                    program.optString("title"), program.optLong("start"), program.optLong("duration"), program.optBoolean("isNow")
                ));
            }
            result.add(item);
        }
        return result;
    }

    private void renderGuide() {
        guideRows.removeAllViews();
        DateFormat time = DateFormat.getTimeInstance(DateFormat.SHORT);
        for (GuideChannel channel : channels) {
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(5), 0, dp(5));
            Button rail = button(channel.name, channel.id.equals(currentChannelId));
            rail.setAllCaps(false);
            rail.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            rail.setOnClickListener(view -> { guidePanel.setVisibility(View.GONE); tune(channel.id); });
            row.addView(rail, new LinearLayout.LayoutParams(dp(155), dp(66)));

            HorizontalScrollView horizontal = new HorizontalScrollView(this);
            horizontal.setHorizontalScrollBarEnabled(false);
            LinearLayout programs = new LinearLayout(this);
            programs.setOrientation(LinearLayout.HORIZONTAL);
            for (GuideProgram program : channel.programs) {
                Button cell = button(time.format(new Date(program.start)) + "\n" + program.title, program.now);
                cell.setAllCaps(false);
                cell.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                cell.setTextSize(12);
                cell.setOnClickListener(view -> { guidePanel.setVisibility(View.GONE); tune(channel.id); });
                int width = Math.max(dp(145), Math.min(dp(330), (int) (program.duration / 60_000f * dp(2.2f))));
                LinearLayout.LayoutParams cellParams = new LinearLayout.LayoutParams(width, dp(66));
                cellParams.setMargins(dp(6), 0, 0, 0);
                programs.addView(cell, cellParams);
            }
            if (channel.programs.isEmpty()) programs.addView(label("Nothing scheduled", 13, DIM, false));
            horizontal.addView(programs, new HorizontalScrollView.LayoutParams(-2, dp(66)));
            row.addView(horizontal, new LinearLayout.LayoutParams(0, dp(66), 1));
            guideRows.addView(row, new LinearLayout.LayoutParams(-1, dp(76)));
        }
    }

    private void tune(String channelId) {
        if (serverRoot == null || channelId == null) return;
        currentChannelId = channelId;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_CHANNEL, channelId).apply();
        renderGuide();
        showStatus("Tuning channel", "Requesting the current program…", true);
        handler.removeCallbacks(boundaryRetune);
        int generation = ++tuneGeneration;
        String url = HeadendUrl.endpoint(serverRoot, "viewer/tune/" + Uri.encode(channelId));
        network.execute(() -> {
            long requestedAt = System.currentTimeMillis();
            try {
                JSONObject json = getJson(url);
                runOnUiThread(() -> {
                    if (generation != tuneGeneration) return;
                    applyTune(json, requestedAt);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (generation != tuneGeneration) return;
                    showStatus("Channel is not ready", readable(error), false);
                    handler.postDelayed(boundaryRetune, 2500);
                });
            }
        });
    }

    private void applyTune(JSONObject json, long requestedAt) {
        JSONObject channel = json.optJSONObject("channel");
        JSONObject playback = json.optJSONObject("playback");
        if (playback == null) {
            showStatus("Invalid tune response", "Headend did not return playback information.", false);
            return;
        }
        channelLabel.setText(channel == null ? currentChannelId : channel.optString("name", currentChannelId));
        titleLabel.setText(playback.optString("title", "Live channel"));
        JSONObject next = json.optJSONObject("next");
        nextLabel.setText(next == null ? "No upcoming program information" : "Next · " + next.optString("title"));

        fallbackHlsUrl = HeadendUrl.endpoint(serverRoot, playback.optString("hlsPath"));
        String videoCodec = nullIfEmpty(playback.optString("videoCodec", ""));
        String audioCodec = nullIfEmpty(playback.optString("audioCodec", ""));
        boolean recommended = "direct".equals(playback.optString("mode"));
        boolean deviceReady = codecsSupported(videoCodec, audioCodec);
        long networkElapsed = Math.max(0, System.currentTimeMillis() - requestedAt);
        long offset = Math.max(0, playback.optLong("offsetMs") + networkElapsed);

        if (recommended && deviceReady) {
            String direct = playback.optString("directUrl", "");
            if (!direct.isEmpty()) playDirect(direct, offset, videoCodec, audioCodec);
            else playHls(fallbackHlsUrl);
        } else {
            playHls(fallbackHlsUrl);
        }

        long serverTime = json.optLong("serverTime", System.currentTimeMillis());
        long endsAt = playback.optLong("endsAt", serverTime + 60_000);
        long delay = Math.max(1000, endsAt - serverTime - networkElapsed + 250);
        handler.postDelayed(boundaryRetune, delay);
    }

    private void playDirect(String url, long offset, String videoCodec, String audioCodec) {
        playingDirect = true;
        modeLabel.setText("DIRECT");
        modeLabel.setTextColor(GREEN);
        MediaItem item = MediaItem.fromUri(url);
        player.setMediaItem(item, offset);
        player.prepare();
        player.play();
    }

    private void playHls(String url) {
        playingDirect = false;
        modeLabel.setText("HEADEND HLS");
        modeLabel.setTextColor(AMBER);
        MediaItem item = new MediaItem.Builder().setUri(url).setMimeType(MimeTypes.APPLICATION_M3U8).build();
        player.setMediaItem(item);
        player.prepare();
        player.play();
    }

    private boolean codecsSupported(String video, String audio) {
        return decoderAvailable(videoMime(video)) && (audio == null || decoderAvailable(audioMime(audio)));
    }

    private boolean decoderAvailable(String mime) {
        if (mime == null) return false;
        try {
            for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) if (mime.equalsIgnoreCase(type)) return true;
            }
        } catch (Exception ignored) {
            return false;
        }
        return false;
    }

    private String videoMime(String codec) {
        if (codec == null) return null;
        switch (codec) {
            case "h264": return "video/avc";
            case "hevc": return "video/hevc";
            case "vp8": return "video/x-vnd.on2.vp8";
            case "vp9": return "video/x-vnd.on2.vp9";
            case "av1": return "video/av01";
            default: return null;
        }
    }

    private String audioMime(String codec) {
        if (codec == null) return null;
        switch (codec) {
            case "aac": return "audio/mp4a-latm";
            case "mp3": return "audio/mpeg";
            case "ac3": return "audio/ac3";
            case "eac3": return "audio/eac3";
            case "opus": return "audio/opus";
            case "vorbis": return "audio/vorbis";
            case "flac": return "audio/flac";
            default: return null;
        }
    }

    private JSONObject getJson(String address) throws Exception {
        IOException failure = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return requestJson(address);
            } catch (IOException error) {
                failure = error;
            }
        }
        throw failure == null ? new IOException("Connection failed") : failure;
    }

    private JSONObject requestJson(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Connection", "close");
        connection.setRequestProperty("User-Agent", "Headend-Android/0.1");
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder body = new StringBuilder();
        if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        } finally {
            connection.disconnect();
        }
        if (status < 200 || status >= 300) throw new IllegalStateException("Headend returned " + status);
        return new JSONObject(body.toString());
    }

    private void surf(int direction) {
        if (channels.isEmpty()) return;
        int current = 0;
        for (int i = 0; i < channels.size(); i++) if (channels.get(i).id.equals(currentChannelId)) current = i;
        int next = (current + direction + channels.size()) % channels.size();
        tune(channels.get(next).id);
    }

    private void retuneCurrent() {
        if (currentChannelId != null) tune(currentChannelId);
    }

    private GuideChannel findChannel(String id) {
        if (id == null) return null;
        for (GuideChannel channel : channels) if (channel.id.equals(id)) return channel;
        return null;
    }

    private void toggleGuide() {
        guidePanel.setVisibility(guidePanel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
    }

    private void showStatus(String title, String detail, boolean loading) {
        statusTitle.setText(title);
        statusDetail.setText(detail);
        statusProgress.setVisibility(loading ? View.VISIBLE : View.GONE);
        statusAction.setVisibility(loading ? View.GONE : View.VISIBLE);
        statusPanel.setVisibility(View.VISIBLE);
    }

    private void hideStatus() { statusPanel.setVisibility(View.GONE); }

    private TextView label(String text, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(sp);
        view.setGravity(Gravity.CENTER_VERTICAL);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button button(String text, boolean primary) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(primary ? AMBER : TEXT);
        button.setTextSize(12);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setBackground(rounded(primary ? Color.rgb(48, 39, 22) : PANEL_2, primary ? AMBER : LINE, 7));
        return button;
    }

    private GradientDrawable rounded(int fill, int stroke, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setStroke(dp(1), stroke);
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    private FrameLayout.LayoutParams match() { return new FrameLayout.LayoutParams(-1, -1); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private String nullIfEmpty(String value) { return value == null || value.isEmpty() || "null".equals(value) ? null : value; }
    private String readable(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    @Override public void onBackPressed() {
        if (guidePanel.getVisibility() == View.VISIBLE) guidePanel.setVisibility(View.GONE);
        else super.onBackPressed();
    }

    @Override protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        network.shutdownNow();
        if (player != null) player.release();
        super.onDestroy();
    }

    private static final class GuideChannel {
        final String id;
        final String name;
        final List<GuideProgram> programs = new ArrayList<>();
        GuideChannel(String id, String name) { this.id = id; this.name = name; }
    }

    private static final class GuideProgram {
        final String title;
        final long start;
        final long duration;
        final boolean now;
        GuideProgram(String title, long start, long duration, boolean now) {
            this.title = title; this.start = start; this.duration = duration; this.now = now;
        }
    }
}
