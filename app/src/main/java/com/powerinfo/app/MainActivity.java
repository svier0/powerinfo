package com.powerinfo.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#111318"));
        w.setNavigationBarColor(Color.parseColor("#111318"));

        RootExecutor root = new RootExecutor(this);
        PowerInfoBridge bridge = new PowerInfoBridge(root);

        webView = new WebView(this);
        // Push the web content below the system status bar so the top bar
        // ("PowerInfo" + ⋮) is not overlapped by the status bar / notch area.
        // WebView.setPadding does NOT move web content (it only affects the view's
        // own insets and is ignored by the rendered surface), so we place the
        // WebView inside a container whose top padding equals the status bar height.
        int statusBarH = getStatusBarHeight();
        Log.d("PowerInfo", "status_bar_height=" + statusBarH + "px (from android resources)");
        android.widget.FrameLayout rootLayout = new android.widget.FrameLayout(this);
        rootLayout.setPadding(0, statusBarH, 0, 0);
        rootLayout.addView(webView,
                new android.widget.FrameLayout.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // Keep CSS px == device-independent px (deterministic 1:1 with dp/density).
        // Disabling the wide-viewport / overview modes prevents the WebView from
        // picking its own viewport scale, which made CSS->physical mapping erratic.
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.addJavascriptInterface(bridge, "powerinfo");
        webView.setWebViewClient(new WebViewClient());

        webView.loadUrl("file:///android_asset/index.html");
    }

    /** Status bar height in px, from resources (fallback 0). */
    private int getStatusBarHeight() {
        int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resId > 0) {
            return getResources().getDimensionPixelSize(resId);
        }
        return 0;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
