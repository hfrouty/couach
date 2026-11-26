package app.studymate.android;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;

public final class MainActivity extends Activity {
    private static final String HOST = "couach-production.up.railway.app";
    private static final String HOME = "https://" + HOST + "/";
    private static final String GOOGLE_SIGN_IN = "/api/auth/campus/start";
    private static final int LOCATION_REQUEST = 1;

    private FrameLayout root;
    private FrameLayout offline;
    private ProgressBar progress;
    private WebView webView;
    private String retryUrl = HOME;
    private String pendingOrigin;
    private GeolocationPermissions.Callback pendingLocation;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.paper));

        offline = createOfflinePanel();
        root.addView(offline, fillParent());
        offline.setVisibility(View.GONE);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(getColor(R.color.teal)));
        root.addView(progress, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));
        progress.setVisibility(View.GONE);

        createWebView();
        setContentView(root);
        applyWindowInsets();

        if (state != null) {
            String savedUrl = state.getString("retry_url", HOME);
            if (isFirstParty(Uri.parse(savedUrl))) retryUrl = savedUrl;
            Bundle webState = state.getBundle("web_state");
            if (webState != null && webView.restoreState(webState) != null) return;
        }
        webView.loadUrl(retryUrl);
    }

    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.paper));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new SiteNavigation());
        webView.setWebChromeClient(new SitePermissions());
        root.addView(webView, 0, fillParent());
    }

    private final class SiteNavigation extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!request.isForMainFrame()) return !isFirstParty(uri);

            if (isFirstParty(uri)) {
                if (GOOGLE_SIGN_IN.equals(uri.getPath()) && "GET".equals(request.getMethod())) {
                    // The OAuth state must be created in the same browser that completes the flow.
                    openGoogleInBrowser(uri);
                    return true;
                }
                return false;
            }

            if (request.hasGesture()) openExternal(uri);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // shouldOverrideUrlLoading does not handle every top-level request, including POST.
            if (request.isForMainFrame() && !isFirstParty(request.getUrl())) {
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (!isFirstParty(Uri.parse(url))) {
                view.stopLoading();
                showOffline();
                return;
            }
            retryUrl = url;
            offline.setVisibility(View.GONE);
            view.setVisibility(View.VISIBLE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (retryUrl.equals(error.getUrl())) showOffline();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            root.removeView(view);
            view.destroy();
            clearLocationPrompt();
            createWebView();
            showOffline();
            return true;
        }
    }

    private final class SitePermissions extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int percent) {
            progress.setProgress(percent);
            progress.setVisibility(percent < 100 && offline.getVisibility() == View.GONE
                ? View.VISIBLE : View.GONE);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (!isSiteOrigin(origin) || pendingLocation != null) {
                callback.invoke(origin, false, false);
                return;
            }
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingOrigin = origin;
            pendingLocation = callback;
            requestPermissions(new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION
            }, LOCATION_REQUEST);
        }

        @Override
        public void onGeolocationPermissionsHidePrompt() {
            clearLocationPrompt();
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != LOCATION_REQUEST || pendingLocation == null) return;

        String origin = pendingOrigin;
        GeolocationPermissions.Callback callback = pendingLocation;
        clearLocationPrompt();
        callback.invoke(origin, isSiteOrigin(origin) && hasLocationPermission(), false);
    }

    private static boolean isFirstParty(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        String authority = uri.getEncodedAuthority();
        return HOST.equalsIgnoreCase(authority) || (HOST + ":443").equalsIgnoreCase(authority);
    }

    private static boolean isSiteOrigin(String origin) {
        if (origin == null) return false;
        Uri uri = Uri.parse(origin);
        String path = uri.getPath();
        return isFirstParty(uri) && (path == null || path.isEmpty() || "/".equals(path))
            && uri.getQuery() == null && uri.getFragment() == null;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void clearLocationPrompt() {
        pendingOrigin = null;
        pendingLocation = null;
    }

    private boolean openExternal(Uri uri) {
        String scheme = uri.getScheme();
        boolean isWebLink = "https".equalsIgnoreCase(scheme) && uri.getHost() != null
            && uri.getEncodedUserInfo() == null;
        boolean isEmailLink = "mailto".equalsIgnoreCase(scheme);
        if (!isWebLink && !isEmailLink && !"geo".equalsIgnoreCase(scheme)) return false;

        Intent intent = new Intent(isEmailLink ? Intent.ACTION_SENDTO : Intent.ACTION_VIEW, uri);
        if (!isEmailLink) intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
            return true;
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_handler, Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    private void openGoogleInBrowser(Uri uri) {
        if (openExternal(uri)) {
            Toast.makeText(this, R.string.google_in_browser, Toast.LENGTH_LONG).show();
        }
    }

    private void applyWindowInsets() {
        if (Build.VERSION.SDK_INT < 30) return;

        getWindow().setDecorFitsSystemWindows(false);
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) {
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(flags, flags);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }

    private FrameLayout createOfflinePanel() {
        FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(getColor(R.color.paper));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.addView(content, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_studymate);
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        content.addView(logo, new LinearLayout.LayoutParams(dp(68), dp(68)));

        TextView title = new TextView(this);
        title.setText(R.string.offline_title);
        title.setTextColor(getColor(R.color.ink));
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setPadding(0, dp(12), 0, dp(4));
        content.addView(title);

        TextView description = new TextView(this);
        description.setText(R.string.offline_description);
        description.setTextColor(getColor(R.color.ink));
        description.setTextSize(16);
        description.setGravity(Gravity.CENTER);
        description.setPadding(0, 0, 0, dp(16));
        content.addView(description);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setTextColor(getColor(android.R.color.white));
        retry.setBackgroundTintList(ColorStateList.valueOf(getColor(R.color.teal)));
        retry.setOnClickListener(view -> webView.loadUrl(retryUrl));
        content.addView(retry);

        Button openBrowser = new Button(this, null, android.R.attr.borderlessButtonStyle);
        openBrowser.setText(R.string.open_browser);
        openBrowser.setTextColor(getColor(R.color.teal));
        openBrowser.setOnClickListener(view -> openExternal(Uri.parse(HOME)));
        content.addView(openBrowser);
        return panel;
    }

    private void showOffline() {
        progress.setVisibility(View.GONE);
        webView.setVisibility(View.INVISIBLE);
        offline.setVisibility(View.VISIBLE);
    }

    private FrameLayout.LayoutParams fillParent() {
        return new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        Bundle webState = new Bundle();
        webView.saveState(webState);
        outState.putBundle("web_state", webState);
        outState.putString("retry_url", retryUrl);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onStop() {
        webView.onPause();
        webView.pauseTimers();
        CookieManager.getInstance().flush();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        clearLocationPrompt();
        root.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
