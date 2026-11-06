package com.powerinfo.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Executes shell commands with root (su) privileges.
 * su resolution order:
 *   1. Custom su command set by user (persisted in SharedPreferences)
 *   2. Global su candidates on common locations
 *   3. "su" on PATH
 * If none yields uid=0 -> root not available.
 */
public class RootExecutor {

    private static final String PREFS = "powerinfo";
    private static final String KEY_SU_CMD = "su_cmd";

    private static final String[] GLOBAL_SU_CANDIDATES = {
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/su/bin/su",
            "/su/su",
            "/vendor/bin/su",
    };

    private final Context context;
    private String cachedSuPath; // null = unknown / not resolved

    public RootExecutor(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Returns the resolved su executable, or null if root is unavailable. */
    public synchronized String getSuPath() {
        if (cachedSuPath != null) {
            return cachedSuPath;
        }
        // 1. custom su command from prefs.
        // NOTE: do NOT check file existence here. Some root solutions (e.g. skroot)
        // expose `su` through a shell function/alias that has no backing file on disk,
        // yet is fully usable inside a shell. Trust the user's value and try to run it.
        String custom = getCustomSuCmd();
        if (custom != null && !custom.trim().isEmpty()) {
            if (isRootShell(custom.trim())) {
                cachedSuPath = custom.trim();
                return cachedSuPath;
            }
        }
        // 2. global candidates
        for (String c : GLOBAL_SU_CANDIDATES) {
            if (isRootShell(c)) {
                cachedSuPath = c;
                return cachedSuPath;
            }
        }
        // 3. "su" on PATH
        if (isRootShell("su")) {
            cachedSuPath = "su";
            return cachedSuPath;
        }
        return null;
    }

    /**
     * Run one command through su, returning stdout+stderr as a string (never null).
     * Uses {@code /system/bin/sh -c} so that shell functions/builtins provided by the
     * root solution (e.g. skroot) participate in resolving the su command. We never
     * check file existence of the su path, since the effective command may live only
     * inside the shell environment.
     */
    public String run(String command) throws Exception {
        String su = getSuPath();
        if (su == null) {
            throw new IllegalStateException("需要root权限");
        }
        Process process = new ProcessBuilder("/system/bin/sh", "-c",
                su + " -c " + shellQuote(command))
                .redirectErrorStream(true)
                .start();
        String out = readFully(process.getInputStream(), 1024 * 1024);
        process.waitFor(20, TimeUnit.SECONDS);
        return out == null ? "" : out;
    }

    /** Single-quote a string for safe embedding in a shell command. */
    private static String shellQuote(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /**
     * True if running the given su path with {@code id} yields uid=0.
     * Also uses {@code sh -c} so shell-function-based su (skroot) is detected.
     */
    private boolean isRootShell(String suPath) {
        try {
            Process process = new ProcessBuilder("/system/bin/sh", "-c",
                    suPath + " -c " + shellQuote("id"))
                    .redirectErrorStream(true)
                    .start();
            String out = readFully(process.getInputStream(), 64 * 1024);
            process.waitFor(10, TimeUnit.SECONDS);
            return out != null && out.contains("uid=0");
        } catch (Exception e) {
            return false;
        }
    }

    public void resetCache() {
        cachedSuPath = null;
    }

    public String getCustomSuCmd() {
        return prefs().getString(KEY_SU_CMD, "");
    }

    public void setCustomSuCmd(String cmd) {
        prefs().edit().putString(KEY_SU_CMD, cmd == null ? "" : cmd.trim()).apply();
        resetCache();
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String readFully(InputStream in, int max) throws Exception {
        StringBuilder sb = new StringBuilder();
        byte[] buf = new byte[4096];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            if (total + n > max) {
                sb.append(new String(buf, 0, max - total, StandardCharsets.UTF_8));
                break;
            }
            sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            total += n;
        }
        return sb.toString();
    }
}
