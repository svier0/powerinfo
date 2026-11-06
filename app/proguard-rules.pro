# Keep WebView JavascriptInterface methods (called from JS reflection)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
# Keep WebView
-keep class android.webkit.** { *; }
