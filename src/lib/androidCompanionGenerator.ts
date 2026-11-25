export interface CompanionSourceFile {
  path: string;
  content: string;
}

export function buildAndroidCompanionSource(origin: string): {
  wsUrl: string;
  files: CompanionSourceFile[];
} {
  let wsUrl = '/ws/mobile-bridge';
  try {
    const parsed = new URL(origin);
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${proto}//${parsed.host}/ws/mobile-bridge`;
  } catch {
    wsUrl = 'wss://your-zacma-host/ws/mobile-bridge';
  }

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.zacma.simbridge">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.SEND_SMS" />
    <uses-permission android:name="android.permission.READ_PHONE_STATE" />
    <uses-permission android:name="android.permission.READ_PHONE_NUMBERS" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application
        android:allowBackup="false"
        android:label="ZACMA SIM Bridge"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  const mainActivityKt = `package com.zacma.simbridge

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * ZACMA Android SIM Bridge Companion (Auto-Permission + Dual SIM SmsManager)
 * Pre-configured WebSocket URL: ${wsUrl}
 */
class MainActivity : ComponentActivity() {
  private val defaultWsUrl = "${wsUrl}"
  private val okHttpClient = OkHttpClient.Builder()
    .pingInterval(25, TimeUnit.SECONDS)
    .build()

  private var activeSocket: WebSocket? = null

  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { grants ->
    val smsOk = grants[Manifest.permission.SEND_SMS] == true
    val phoneOk = grants[Manifest.permission.READ_PHONE_STATE] == true
    if (smsOk && phoneOk) {
      Toast.makeText(this, "ZACMA SIM permissions granted!", Toast.LENGTH_SHORT).show()
    } else {
      Toast.makeText(this, "Allow SMS and Phone State permissions to send via SIM.", Toast.LENGTH_LONG).show()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestRequiredSimPermissions()
  }

  private fun requestRequiredSimPermissions() {
    val needed = mutableListOf(
      Manifest.permission.SEND_SMS,
      Manifest.permission.READ_PHONE_STATE
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      needed.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    val missing = needed.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      permissionLauncher.launch(missing.toTypedArray())
    }
  }

  fun pairFromScannedQr(rawQrText: String) {
    val (wsUrl, pairingCode, simSlot) = parseQrPayload(rawQrText)
    val request = Request.Builder().url(wsUrl).build()
    activeSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        val frame = JSONObject().apply {
          put("type", "device:pair")
          put("pairingCode", pairingCode)
          put("deviceName", "\${Build.MANUFACTURER} \${Build.MODEL}")
          put("androidVersion", "Android \${Build.VERSION.RELEASE}")
          put("simSlot", simSlot)
          put("dualSimSupported", true)
          put("clientType", "android-native")
        }
        webSocket.send(frame.toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        val msg = JSONObject(text)
        when (msg.optString("type")) {
          "sms:dispatch" -> {
            val jobId = msg.getString("jobId")
            val to = msg.getString("to")
            val body = msg.getString("message")
            val slot = msg.optString("simSlot", "auto")
            sendViaNativeSmsManager(webSocket, jobId, to, body, slot)
          }
        }
      }
    })
  }

  private fun parseQrPayload(raw: String): Triple<String, String, String> {
    return if (raw.trim().startsWith("{")) {
      val obj = JSONObject(raw)
      Triple(
        obj.optString("wsUrl", defaultWsUrl),
        obj.getString("pairingCode"),
        obj.optString("simSlot", "auto")
      )
    } else {
      val uri = Uri.parse(raw)
      val code = uri.getQueryParameter("pair") ?: raw.trim()
      val sim = uri.getQueryParameter("sim") ?: "auto"
      Triple(defaultWsUrl, code, sim)
    }
  }

  private fun sendViaNativeSmsManager(
    webSocket: WebSocket,
    jobId: String,
    to: String,
    body: String,
    slot: String
  ) {
    try {
      val subManager = getSystemService(SubscriptionManager::class.java)
      val simIndex = when (slot) { "sim1" -> 0; "sim2" -> 1; else -> -1 }
      val subInfo = if (simIndex >= 0) subManager?.activeSubscriptionInfoList?.getOrNull(simIndex) else null
      val smsManager = if (subInfo != null) {
        getSystemService(SmsManager::class.java).createForSubscriptionId(subInfo.subscriptionId)
      } else {
        getSystemService(SmsManager::class.java)
      }

      val sentAction = "ZACMA_SMS_SENT_\$jobId"
      val deliveredAction = "ZACMA_SMS_DLR_\$jobId"

      registerReceiver(object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          try { unregisterReceiver(this) } catch (_: Exception) {}
          val ok = resultCode == Activity.RESULT_OK
          webSocket.send(JSONObject(mapOf(
            "type" to "sms:result",
            "jobId" to jobId,
            "status" to if (ok) "sent" else "failed",
            "error" to if (ok) "" else "Carrier SmsManager error code \$resultCode"
          )).toString())
        }
      }, IntentFilter(sentAction), Context.RECEIVER_NOT_EXPORTED)

      registerReceiver(object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          try { unregisterReceiver(this) } catch (_: Exception) {}
          webSocket.send(JSONObject(mapOf(
            "type" to "sms:dlr",
            "jobId" to jobId,
            "status" to if (resultCode == Activity.RESULT_OK) "delivered" else "failed"
          )).toString())
        }
      }, IntentFilter(deliveredAction), Context.RECEIVER_NOT_EXPORTED)

      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val sentPi = PendingIntent.getBroadcast(this, jobId.hashCode(), Intent(sentAction), flags)
      val deliveredPi = PendingIntent.getBroadcast(this, jobId.hashCode() + 1, Intent(deliveredAction), flags)

      val parts = smsManager.divideMessage(body)
      val sentIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(sentPi) } }
      val deliveryIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(deliveredPi) } }
      smsManager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveryIntents)
    } catch (e: Exception) {
      webSocket.send(JSONObject(mapOf(
        "type" to "sms:result",
        "jobId" to jobId,
        "status" to "failed",
        "error" to (e.message ?: "SIM send exception")
      )).toString())
    }
  }
}`;

  return {
    wsUrl,
    files: [
      { path: 'app/src/main/AndroidManifest.xml', content: manifestXml },
      { path: 'app/src/main/java/com/zacma/simbridge/MainActivity.kt', content: mainActivityKt },
    ],
  };
}
