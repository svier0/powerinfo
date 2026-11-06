package com.powerinfo.app;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * The ONLY bridge exposed to the WebView (window.powerinfo).
 *
 * Contract with the front end (per user m00277: "所有东西应该都是前端就解决了 后端就一个读取接口"):
 *   - The front end owns ALL display logic, unit conversion and formatting.
 *   - This backend exposes exactly one read entry point: readRaw(), which returns the RAW
 *     (unconverted) sysfs values for the battery node. The JS side converts them.
 *
 * Values come from /sys/class/power_supply/battery/. File names are an internal detail and
 * are never surfaced to the UI.
 */
public class PowerInfoBridge {

    private static final String BATTERY_DIR = "/sys/class/power_supply/battery";
    private static final String[] BATTERY_FIELDS = {
            "temp", "capacity", "current_now", "voltage_now",
            "status", "technology", "health",
            "charge_full_design", "charge_full", "cycle_count", "voltage_max"
    };

    private static final String USB_DIR = "/sys/class/power_supply/usb";
    // Fields the user asked for. Some are vendor-specific and may not exist on a
    // given device (e.g. hvdcp3_type).
    // We read each one tolerantly: missing file -> empty string -> front end shows "--".
    private static final String[] USB_FIELDS = {
            "online", "quick_charge_type",
            "real_type", "voltage_now", "input_current_now",
            "voltage_max", "voltage_max_design", "current_max",
            "pd_active", "pd_authentication", "pd_current_max",
            "pd_voltage_max", "pd_voltage_min", "hvdcp3_type"
    };

    private final RootExecutor root;

    public PowerInfoBridge(RootExecutor root) {
        this.root = root;
    }

    /** Build a shell snippet that prints "name=value" lines for the given dir+fields. */
    private static String buildReadCmd(String dir, String[] fields) {
        StringBuilder cmd = new StringBuilder();
        cmd.append("for f in ");
        for (String f : fields) cmd.append(f).append(' ');
        cmd.append("; do if [ -e \"").append(dir).append("/$f\" ]; then ");
        cmd.append("printf '%s=' \"$f\"; cat \"").append(dir).append("/$f\" 2>/dev/null; printf '\\n'; ");
        cmd.append("fi; done");
        return cmd.toString();
    }

    /** Parse "name=value" lines into a JSONObject (all fields default to ""). */
    private static JSONObject parseFields(String out, String[] fields) throws Exception {
        JSONObject obj = new JSONObject();
        for (String f : fields) obj.put(f, "");
        String[] lines = out.split("\\r?\\n");
        for (String line : lines) {
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            String name = line.substring(0, eq);
            String val = line.substring(eq + 1).trim();
            for (String f : fields) {
                if (f.equals(name)) {
                    obj.put(f, val);
                    break;
                }
            }
        }
        return obj;
    }

    /**
     * Returns {ok, su, battery:{...}, usb:{...}, error}. Both battery and usb hold RAW
     * (unconverted) string values; the front end owns all formatting/unit conversion.
     * Battery and usb are read in two separate su sessions so that shared field names
     * (voltage_now, voltage_max) never collide across the two nodes.
     */
    @JavascriptInterface
    public String readRaw() {
        JSONObject result = new JSONObject();
        try {
            String su = root.getSuPath();
            if (su == null) {
                result.put("ok", false);
                result.put("error", "需要root权限");
                return result.toString();
            }
            String batteryOut = root.run(buildReadCmd(BATTERY_DIR, BATTERY_FIELDS));
            String usbOut = root.run(buildReadCmd(USB_DIR, USB_FIELDS));

            JSONObject battery = parseFields(batteryOut, BATTERY_FIELDS);
            JSONObject usb = parseFields(usbOut, USB_FIELDS);

            result.put("ok", true);
            result.put("su", su);
            result.put("battery", battery);
            result.put("usb", usb);
        } catch (Exception e) {
            try {
                result.put("ok", false);
                result.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) {
            }
        }
        return result.toString();
    }

    /** Returns {suCmd, rootAvailable}. */
    @JavascriptInterface
    public String getConfig() {
        JSONObject o = new JSONObject();
        try {
            o.put("suCmd", root.getCustomSuCmd());
            o.put("rootAvailable", root.getSuPath() != null);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    @JavascriptInterface
    public void setSuCmd(String cmd) {
        root.setCustomSuCmd(cmd);
    }
}
