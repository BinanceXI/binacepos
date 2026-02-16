package com.themasters.pos;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Build;
import android.webkit.PermissionRequest;
import java.util.ArrayList;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

  private static final int REQ_RUNTIME_PERMS = 1001;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // 1) Ask runtime permissions needed by POS features.
    ArrayList<String> neededPerms = new ArrayList<>();
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      neededPerms.add(Manifest.permission.CAMERA);
    }

    // Android 12+ requires runtime Bluetooth permissions.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
          != PackageManager.PERMISSION_GRANTED) {
        neededPerms.add(Manifest.permission.BLUETOOTH_CONNECT);
      }
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
          != PackageManager.PERMISSION_GRANTED) {
        neededPerms.add(Manifest.permission.BLUETOOTH_SCAN);
      }
    } else {
      // Older Android versions may still require location permission for bluetooth operations.
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
          != PackageManager.PERMISSION_GRANTED) {
        neededPerms.add(Manifest.permission.ACCESS_FINE_LOCATION);
      }
    }

    if (!neededPerms.isEmpty()) {
      ActivityCompat.requestPermissions(
        this,
        neededPerms.toArray(new String[0]),
        REQ_RUNTIME_PERMS
      );
    }

    // 2) Allow WebView (getUserMedia) permission requests
    bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        runOnUiThread(() -> request.grant(request.getResources()));
      }
    });
  }
}
