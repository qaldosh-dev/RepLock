const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.RepLockAccessibilityService';
const SERVICE_LABEL = 'RepLock App Protection';
const SERVICE_RESOURCE = '@xml/replock_accessibility_service';
const LOCKED_PACKAGE_NAMES = [
  'com.zhiliaoapp.musically',
  'com.instagram.android',
  'com.google.android.youtube',
];

const KOTLIN_SOURCE = `package com.replock.pushtounlock54

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import android.view.accessibility.AccessibilityEvent

class RepLockAccessibilityService : AccessibilityService() {
  private val lastEventAtByPackage = mutableMapOf<String, Long>()
  private val lastRedirectAtByPackage = mutableMapOf<String, Long>()
  private var activeBlockedPackage: String? = null
  private var lastForegroundPackage: String? = null
  private var lastBlockReason = "None yet"
  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == Intent.ACTION_SCREEN_OFF) {
        activeBlockedPackage = null
        lastBlockReason = "screen_off"
        RepLockOverlayController.hide()
        publishProtectionStatus()
      }
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    registerReceiver(screenReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF))
    RepLockOverlayController.hide()
    publishProtectionStatus()
    Log.i(TAG, "RepLock Accessibility Service connected")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
      return
    }

    val packageName = event.packageName?.toString() ?: return
    lastForegroundPackage = packageName

    val appName = RepLockUnlockStore.getProtectedAppName(applicationContext, packageName)
    if (appName == null) {
      lastBlockReason = "ignored_not_protected:$packageName"
      if (packageName == applicationContext.packageName) {
        lastBlockReason = "replock_foreground"
      }
      publishProtectionStatus()
      return
    }

    val now = System.currentTimeMillis()
    val lastEventAt = lastEventAtByPackage[packageName] ?: 0L
    if (now - lastEventAt >= EVENT_RECORD_COOLDOWN_MS) {
      lastEventAtByPackage[packageName] = now
      RepLockDetectionStore.record(applicationContext, appName, packageName)
      Log.i(TAG, "RepLock detected locked app: $appName")
    }

    if (RepLockUnlockStore.isUnlocked(applicationContext, packageName)) {
      activeBlockedPackage = null
      lastBlockReason = "unlocked_window_active"
      RepLockOverlayController.hide()
      publishProtectionStatus(packageName)
      Log.i(TAG, "RepLock allowed unlocked app: $appName")
      return
    }

    val lastRedirectAt = lastRedirectAtByPackage[packageName] ?: 0L
    if (now - lastRedirectAt < REDIRECT_COOLDOWN_MS) {
      activeBlockedPackage = packageName
      lastBlockReason = "redirect_cooldown"
      publishProtectionStatus(packageName)
      return
    }

    activeBlockedPackage = packageName
    lastBlockReason = "locked_redirect_to_challenge"
    lastRedirectAtByPackage[packageName] = now
    RepLockUnlockStore.beginChallenge(applicationContext, packageName)
    RepLockOverlayController.hide()
    publishProtectionStatus(packageName)
    redirectToChallenge(appName, packageName)
  }

  override fun onInterrupt() {
    activeBlockedPackage = null
    lastBlockReason = "service_interrupted"
    RepLockOverlayController.hide()
    publishProtectionStatus()
    Log.i(TAG, "RepLock Accessibility Service interrupted")
  }

  override fun onDestroy() {
    runCatching { unregisterReceiver(screenReceiver) }
    activeBlockedPackage = null
    lastBlockReason = "service_destroyed"
    RepLockOverlayController.hide()
    publishProtectionStatus()
    super.onDestroy()
  }

  private fun redirectToChallenge(appName: String, packageName: String) {
    try {
      RepLockDetectionStore.recordRedirectAttempt(applicationContext, packageName, "pending")
      RepLockOverlayController.openChallenge(applicationContext, appName, packageName)
      RepLockDetectionStore.recordRedirectAttempt(applicationContext, packageName, "started")
      Log.i(TAG, "RepLock redirected locked app to challenge: $appName")
    } catch (error: Exception) {
      val message = error.message ?: error.javaClass.simpleName
      RepLockDetectionStore.recordRedirectAttempt(applicationContext, packageName, "failed:$message")
      Log.e(TAG, "RepLock failed to redirect locked app: $appName", error)
    } finally {
      publishProtectionStatus(packageName)
    }
  }

  private fun publishProtectionStatus(statusPackage: String? = activeBlockedPackage ?: lastForegroundPackage) {
    RepLockDetectionStore.updateProtectionStatus(
      applicationContext,
      RepLockOverlayController.isVisible(),
      activeBlockedPackage,
      lastForegroundPackage,
      lastBlockReason,
      statusPackage,
    )
  }

  companion object {
    private const val TAG = "RepLockProtection"
    private const val EVENT_RECORD_COOLDOWN_MS = 1200L
    private const val REDIRECT_COOLDOWN_MS = 1500L
  }
}
`;

const DETECTION_STORE_SOURCE = `package com.replock.pushtounlock54

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object RepLockDetectionStore {
  private const val PREFS_NAME = "replock_detection_debug"
  private const val KEY_TOTAL_COUNT = "total_count"
  private const val KEY_LAST_EVENT = "last_event"
  private const val KEY_HISTORY = "history"
  private const val KEY_PROTECTION_STATUS = "protection_status"
  private const val KEY_LAST_REDIRECT_PACKAGE = "last_redirect_package"
  private const val KEY_LAST_REDIRECT_RESULT = "last_redirect_result"
  private const val KEY_LAST_REDIRECT_AT = "last_redirect_at"
  private const val KEY_LAST_UNLOCK_PACKAGE = "last_unlock_package"
  private const val KEY_LAST_UNLOCK_AT = "last_unlock_at"
  private const val KEY_LAST_LAUNCH_ATTEMPT_PACKAGE = "last_launch_attempt_package"
  private const val KEY_LAST_LAUNCH_RESULT = "last_launch_result"
  private const val KEY_LAST_LAUNCH_AT = "last_launch_at"
  private const val KEY_CHALLENGE_PACKAGE_NAME = "challenge_package_name"
  private const val KEY_UNLOCK_APP_CALLED_PACKAGE = "unlock_app_called_package"
  private const val KEY_UNLOCKED_UNTIL_SAVED = "unlocked_until_saved"
  private const val KEY_POST_UNLOCK_GRACE_UNTIL_SAVED = "post_unlock_grace_until_saved"
  private const val KEY_LAUNCH_INTENT_FOUND = "launch_intent_found"
  private const val KEY_LAUNCH_METHOD_USED = "launch_method_used"
  private const val KEY_FINAL_LAUNCH_SUCCESS = "final_launch_success"
  private const val KEY_FINAL_LAUNCH_ERROR_REASON = "final_launch_error_reason"
  private const val KEY_DID_MOVE_REPLOCK_TO_BACK = "did_move_replock_to_back"
  private const val MAX_HISTORY = 20

  fun record(context: Context, appName: String, packageName: String) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val event = JSONObject()
      .put("appName", appName)
      .put("packageName", packageName)
      .put("timestamp", System.currentTimeMillis())

    val previousHistory = JSONArray(prefs.getString(KEY_HISTORY, "[]") ?: "[]")
    val nextHistory = JSONArray().put(event)
    val limit = minOf(previousHistory.length(), MAX_HISTORY - 1)

    for (index in 0 until limit) {
      nextHistory.put(previousHistory.getJSONObject(index))
    }

    prefs.edit()
      .putInt(KEY_TOTAL_COUNT, prefs.getInt(KEY_TOTAL_COUNT, 0) + 1)
      .putString(KEY_LAST_EVENT, event.toString())
      .putString(KEY_HISTORY, nextHistory.toString())
      .apply()
  }

  fun updateProtectionStatus(
    context: Context,
    overlayVisible: Boolean,
    activeBlockedPackage: String?,
    lastForegroundPackage: String?,
    lastBlockReason: String,
    statusPackage: String?,
  ) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val unlockedUntil = RepLockUnlockStore.getUnlockedUntil(context, statusPackage)
    val status = JSONObject()
      .put("overlayVisible", overlayVisible)
      .put("activeBlockedPackage", activeBlockedPackage ?: JSONObject.NULL)
      .put("lastForegroundPackage", lastForegroundPackage ?: JSONObject.NULL)
      .put("lastBlockReason", lastBlockReason)
      .put("selectedProtectedPackageNames", RepLockUnlockStore.snapshotProtectedPackageNames(context))
      .put("unlockedUntil", unlockedUntil)
      .put("remainingUnlockSeconds", RepLockUnlockStore.remainingUnlockSeconds(context, statusPackage))
      .put("lastRedirectPackage", prefs.getString(KEY_LAST_REDIRECT_PACKAGE, null) ?: JSONObject.NULL)
      .put("lastRedirectResult", prefs.getString(KEY_LAST_REDIRECT_RESULT, null) ?: JSONObject.NULL)
      .put("lastRedirectAt", prefs.getLong(KEY_LAST_REDIRECT_AT, 0L))
      .put("lastUnlockPackage", prefs.getString(KEY_LAST_UNLOCK_PACKAGE, null) ?: JSONObject.NULL)
      .put("lastUnlockAt", prefs.getLong(KEY_LAST_UNLOCK_AT, 0L))
      .put("selectedProtectedPackageNames", RepLockUnlockStore.snapshotProtectedPackageNames(context))
      .put("challengePackageName", prefs.getString(KEY_CHALLENGE_PACKAGE_NAME, null) ?: JSONObject.NULL)
      .put("unlockAppCalledPackageName", prefs.getString(KEY_UNLOCK_APP_CALLED_PACKAGE, null) ?: JSONObject.NULL)
      .put("unlockedUntilSaved", prefs.getLong(KEY_UNLOCKED_UNTIL_SAVED, 0L))
      .put("postUnlockGraceUntilSaved", prefs.getLong(KEY_POST_UNLOCK_GRACE_UNTIL_SAVED, 0L))
      .put("launchIntentFound", prefs.getBoolean(KEY_LAUNCH_INTENT_FOUND, false))
      .put("launchMethodUsed", prefs.getString(KEY_LAUNCH_METHOD_USED, null) ?: JSONObject.NULL)
      .put("finalLaunchSuccess", prefs.getBoolean(KEY_FINAL_LAUNCH_SUCCESS, false))
      .put("finalLaunchErrorReason", prefs.getString(KEY_FINAL_LAUNCH_ERROR_REASON, null) ?: JSONObject.NULL)
      .put("didMoveRepLockToBack", prefs.getBoolean(KEY_DID_MOVE_REPLOCK_TO_BACK, false))
      .put(
        "lastLaunchPackage",
        prefs.getString(KEY_LAST_LAUNCH_ATTEMPT_PACKAGE, null) ?: JSONObject.NULL
      )
      .put("lastLaunchResult", prefs.getString(KEY_LAST_LAUNCH_RESULT, null) ?: JSONObject.NULL)
      .put("lastLaunchAt", prefs.getLong(KEY_LAST_LAUNCH_AT, 0L))
      .put("updatedAt", System.currentTimeMillis())

    prefs.edit()
      .putString(KEY_PROTECTION_STATUS, status.toString())
      .apply()
  }

  fun recordRedirectAttempt(context: Context, packageName: String, result: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LAST_REDIRECT_PACKAGE, packageName)
      .putString(KEY_LAST_REDIRECT_RESULT, result)
      .putLong(KEY_LAST_REDIRECT_AT, System.currentTimeMillis())
      .apply()
  }

  fun recordUnlock(context: Context, packageName: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LAST_UNLOCK_PACKAGE, packageName)
      .putLong(KEY_LAST_UNLOCK_AT, System.currentTimeMillis())
      .apply()
  }

  fun recordChallengeOpened(context: Context, packageName: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_CHALLENGE_PACKAGE_NAME, packageName)
      .apply()
  }

  fun recordUnlockCall(
    context: Context,
    packageName: String,
    unlockedUntil: Long,
    postUnlockGraceUntil: Long,
  ) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_UNLOCK_APP_CALLED_PACKAGE, packageName)
      .putLong(KEY_UNLOCKED_UNTIL_SAVED, unlockedUntil)
      .putLong(KEY_POST_UNLOCK_GRACE_UNTIL_SAVED, postUnlockGraceUntil)
      .apply()
  }

  fun recordLaunchResult(
    context: Context,
    packageName: String,
    launchIntentFound: Boolean,
    launchMethodUsed: String,
    finalLaunchSuccess: Boolean,
    finalLaunchErrorReason: String?,
    didMoveRepLockToBack: Boolean,
  ) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LAST_LAUNCH_ATTEMPT_PACKAGE, packageName)
      .putString(KEY_LAST_LAUNCH_RESULT, if (finalLaunchSuccess) "started:$launchMethodUsed" else "failed:$launchMethodUsed")
      .putLong(KEY_LAST_LAUNCH_AT, System.currentTimeMillis())
      .putBoolean(KEY_LAUNCH_INTENT_FOUND, launchIntentFound)
      .putString(KEY_LAUNCH_METHOD_USED, launchMethodUsed)
      .putBoolean(KEY_FINAL_LAUNCH_SUCCESS, finalLaunchSuccess)
      .putString(KEY_FINAL_LAUNCH_ERROR_REASON, finalLaunchErrorReason)
      .putBoolean(KEY_DID_MOVE_REPLOCK_TO_BACK, didMoveRepLockToBack)
      .apply()
  }

  fun recordLaunchAttempt(context: Context, packageName: String, result: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_LAST_LAUNCH_ATTEMPT_PACKAGE, packageName)
      .putString(KEY_LAST_LAUNCH_RESULT, result)
      .putLong(KEY_LAST_LAUNCH_AT, System.currentTimeMillis())
      .apply()
  }

  fun snapshot(context: Context): JSONObject {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val lastEvent = prefs.getString(KEY_LAST_EVENT, null)
    val history = prefs.getString(KEY_HISTORY, "[]") ?: "[]"
    val protectionStatus = JSONObject(prefs.getString(KEY_PROTECTION_STATUS, "{}") ?: "{}")
      .put("lastRedirectPackage", prefs.getString(KEY_LAST_REDIRECT_PACKAGE, null) ?: JSONObject.NULL)
      .put("lastRedirectResult", prefs.getString(KEY_LAST_REDIRECT_RESULT, null) ?: JSONObject.NULL)
      .put("lastRedirectAt", prefs.getLong(KEY_LAST_REDIRECT_AT, 0L))
      .put("lastUnlockPackage", prefs.getString(KEY_LAST_UNLOCK_PACKAGE, null) ?: JSONObject.NULL)
      .put("lastUnlockAt", prefs.getLong(KEY_LAST_UNLOCK_AT, 0L))
      .put("challengePackageName", prefs.getString(KEY_CHALLENGE_PACKAGE_NAME, null) ?: JSONObject.NULL)
      .put("unlockAppCalledPackageName", prefs.getString(KEY_UNLOCK_APP_CALLED_PACKAGE, null) ?: JSONObject.NULL)
      .put("unlockedUntilSaved", prefs.getLong(KEY_UNLOCKED_UNTIL_SAVED, 0L))
      .put("postUnlockGraceUntilSaved", prefs.getLong(KEY_POST_UNLOCK_GRACE_UNTIL_SAVED, 0L))
      .put("launchIntentFound", prefs.getBoolean(KEY_LAUNCH_INTENT_FOUND, false))
      .put("launchMethodUsed", prefs.getString(KEY_LAUNCH_METHOD_USED, null) ?: JSONObject.NULL)
      .put("finalLaunchSuccess", prefs.getBoolean(KEY_FINAL_LAUNCH_SUCCESS, false))
      .put("finalLaunchErrorReason", prefs.getString(KEY_FINAL_LAUNCH_ERROR_REASON, null) ?: JSONObject.NULL)
      .put("didMoveRepLockToBack", prefs.getBoolean(KEY_DID_MOVE_REPLOCK_TO_BACK, false))
      .put(
        "lastLaunchPackage",
        prefs.getString(KEY_LAST_LAUNCH_ATTEMPT_PACKAGE, null) ?: JSONObject.NULL
      )
      .put("lastLaunchResult", prefs.getString(KEY_LAST_LAUNCH_RESULT, null) ?: JSONObject.NULL)
      .put("lastLaunchAt", prefs.getLong(KEY_LAST_LAUNCH_AT, 0L))
    val statusPackage = protectionStatus.optString("activeBlockedPackage").takeIf { it.isNotBlank() && it != "null" }
      ?: protectionStatus.optString("lastForegroundPackage").takeIf { it.isNotBlank() && it != "null" }
    protectionStatus.put("unlockedUntil", RepLockUnlockStore.getUnlockedUntil(context, statusPackage))
    protectionStatus.put(
      "remainingUnlockSeconds",
      RepLockUnlockStore.remainingUnlockSeconds(context, statusPackage)
    )

    return JSONObject()
      .put("totalCount", prefs.getInt(KEY_TOTAL_COUNT, 0))
      .put("lastEvent", if (lastEvent == null) JSONObject.NULL else JSONObject(lastEvent))
      .put("history", JSONArray(history))
      .put("protectionStatus", protectionStatus)
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .clear()
      .apply()
  }
}
`;

const UNLOCK_STORE_SOURCE = `package com.replock.pushtounlock54

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object RepLockUnlockStore {
  private const val PREFS_NAME = "replock_unlock_state"
  private const val UNLOCK_PREFIX = "unlock_until_"
  private const val POST_UNLOCK_GRACE_PREFIX = "post_unlock_grace_until_"
  private const val CHALLENGE_PREFIX = "challenge_until_"
  private const val KEY_REQUIRED_PUSHUPS = "required_pushups"
  private const val KEY_PROTECTED_APPS = "protected_apps"
  private const val CHALLENGE_GRACE_MS = 15 * 1000L
  private const val POST_UNLOCK_GRACE_MS = 3 * 1000L

  fun beginChallenge(context: Context, packageName: String) {
    val until = System.currentTimeMillis() + CHALLENGE_GRACE_MS
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putLong(CHALLENGE_PREFIX + packageName, until)
      .apply()
  }

  fun cancelChallenge(context: Context, packageName: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(CHALLENGE_PREFIX + packageName)
      .apply()
  }

  fun unlock(context: Context, packageName: String, durationMs: Double) {
    val now = System.currentTimeMillis()
    val until = now + durationMs.toLong()
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putLong(UNLOCK_PREFIX + packageName, until)
      .putLong(POST_UNLOCK_GRACE_PREFIX + packageName, now + POST_UNLOCK_GRACE_MS)
      .remove(CHALLENGE_PREFIX + packageName)
      .apply()
  }

  fun getPostUnlockGraceUntil(context: Context, packageName: String?): Long {
    if (packageName == null) {
      return 0L
    }

    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getLong(POST_UNLOCK_GRACE_PREFIX + packageName, 0L)
  }

  fun setRequiredPushups(context: Context, requiredPushups: Double) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putInt(KEY_REQUIRED_PUSHUPS, requiredPushups.toInt())
      .apply()
  }

  fun getRequiredPushups(context: Context): Int {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getInt(KEY_REQUIRED_PUSHUPS, 10)
  }

  fun setProtectedApps(context: Context, protectedAppsJson: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_PROTECTED_APPS, protectedAppsJson)
      .apply()
  }

  fun getProtectedAppName(context: Context, packageName: String): String? {
    return protectedAppMap(context)[packageName]
  }

  fun snapshotProtectedPackageNames(context: Context): JSONArray {
    val packages = JSONArray()
    protectedAppMap(context).keys.sorted().forEach { packageName ->
      packages.put(packageName)
    }
    return packages
  }

  fun isUnlocked(context: Context, packageName: String): Boolean {
    val now = System.currentTimeMillis()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return prefs.getLong(UNLOCK_PREFIX + packageName, 0L) > now ||
      prefs.getLong(POST_UNLOCK_GRACE_PREFIX + packageName, 0L) > now
  }

  fun getUnlockedUntil(context: Context, packageName: String?): Long {
    if (packageName == null) {
      return 0L
    }

    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getLong(UNLOCK_PREFIX + packageName, 0L)
  }

  fun remainingUnlockSeconds(context: Context, packageName: String?): Long {
    if (packageName == null) {
      return 0L
    }

    val now = System.currentTimeMillis()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val remainingMs = prefs.getLong(UNLOCK_PREFIX + packageName, 0L) - now
    if (remainingMs <= 0L) {
      return 0L
    }

    return (remainingMs + 999L) / 1000L
  }

  fun isChallengeInProgress(context: Context, packageName: String): Boolean {
    val now = System.currentTimeMillis()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return prefs.getLong(CHALLENGE_PREFIX + packageName, 0L) > now
  }

  fun snapshotActiveUnlocks(context: Context): JSONArray {
    val now = System.currentTimeMillis()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val sessions = JSONArray()

    protectedAppMap(context).forEach { (packageName, appName) ->
      val unlockedUntil = prefs.getLong(UNLOCK_PREFIX + packageName, 0L)
      if (unlockedUntil > now) {
        sessions.put(
          JSONObject()
            .put("appName", appName)
            .put("packageName", packageName)
            .put("unlockedUntil", unlockedUntil)
            .put("remainingMs", unlockedUntil - now)
        )
      }
    }

    return sessions
  }

  private fun protectedAppMap(context: Context): Map<String, String> {
    val rawJson = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getString(KEY_PROTECTED_APPS, null)

    if (rawJson.isNullOrBlank()) {
      return DEFAULT_PROTECTED_APPS
    }

    val apps = linkedMapOf<String, String>()
    val json = JSONArray(rawJson)
    for (index in 0 until json.length()) {
      val item = json.optJSONObject(index) ?: continue
      val packageName = item.optString("packageName")
      val appName = item.optString("appName", packageName)
      if (packageName.isNotBlank()) {
        apps[packageName] = appName.ifBlank { packageName }
      }
    }

    return apps
  }

  private val DEFAULT_PROTECTED_APPS = linkedMapOf(
    "com.zhiliaoapp.musically" to "TikTok",
    "com.instagram.android" to "Instagram",
    "com.google.android.youtube" to "YouTube",
  )
}
`;

const OVERLAY_CONTROLLER_SOURCE = `package com.replock.pushtounlock54

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.net.URLEncoder

object RepLockOverlayController {
  private var overlayView: View? = null
  private var currentPackageName: String? = null
  private var audioManager: AudioManager? = null
  private var startChallengeListener: ((String) -> Unit)? = null
  private val audioFocusListener = AudioManager.OnAudioFocusChangeListener {}

  fun show(context: Context, appName: String, packageName: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
      android.util.Log.w("RepLockProtection", "Overlay permission missing; cannot block $appName")
      return
    }

    if (overlayView != null && currentPackageName == packageName) {
      return
    }

    hide()

    val appContext = context.applicationContext
    audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audioManager?.requestAudioFocus(
      audioFocusListener,
      AudioManager.STREAM_MUSIC,
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
    )

    val windowManager = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val root = LinearLayout(appContext).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      isFocusable = true
      isFocusableInTouchMode = true
      isClickable = true
      setPadding(48, 48, 48, 48)
      setBackgroundColor(Color.rgb(15, 23, 42))
      setOnClickListener {}
      setOnKeyListener { _, keyCode, _ ->
        keyCode == KeyEvent.KEYCODE_BACK
      }
    }

    fun textView(text: String, size: Float, color: Int = Color.WHITE): TextView {
      return TextView(appContext).apply {
        this.text = text
        textSize = size
        setTextColor(color)
        gravity = Gravity.CENTER
        setPadding(0, 8, 0, 8)
      }
    }

    val title = textView("RepLock", 34f)
    val message = textView("Complete push-ups to unlock", 20f, Color.rgb(204, 251, 241))
    val appLabel = textView(appName, 30f)
    val reps = textView(
      "Required push-ups: \${RepLockUnlockStore.getRequiredPushups(appContext)}",
      18f,
      Color.rgb(203, 213, 225)
    )
    val button = Button(appContext).apply {
      text = "Start Challenge"
      textSize = 18f
      setOnClickListener {
        startChallengeListener?.invoke(packageName)
        RepLockUnlockStore.beginChallenge(appContext, packageName)
        hide()
        openChallenge(appContext, appName, packageName)
      }
    }

    root.addView(title)
    root.addView(message)
    root.addView(appLabel)
    root.addView(reps)
    root.addView(button)

    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      } else {
        WindowManager.LayoutParams.TYPE_PHONE
      },
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_FULLSCREEN or
        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      android.graphics.PixelFormat.TRANSLUCENT
    )

    windowManager.addView(root, params)
    root.requestFocus()
    overlayView = root
    currentPackageName = packageName
  }

  fun isShowingFor(packageName: String): Boolean {
    return overlayView != null && currentPackageName == packageName
  }

  fun isVisible(): Boolean {
    return overlayView != null
  }

  fun setStartChallengeListener(listener: ((String) -> Unit)?) {
    startChallengeListener = listener
  }

  fun hide(packageName: String) {
    if (currentPackageName == packageName) {
      hide()
    }
  }

  fun hide() {
    val view = overlayView ?: return
    val context = view.context.applicationContext
    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    runCatching { windowManager.removeView(view) }
    audioManager?.abandonAudioFocus(audioFocusListener)
    overlayView = null
    currentPackageName = null
  }

  fun openChallenge(context: Context, appName: String, packageName: String) {
    val encodedName = URLEncoder.encode(appName, "UTF-8")
    val encodedPackage = URLEncoder.encode(packageName, "UTF-8")
    val uri = Uri.parse("pushtounlock54://challenge?appName=$encodedName&packageName=$encodedPackage")
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    context.startActivity(intent)
  }
}
`;

const DETECTION_MODULE_SOURCE = `package com.replock.pushtounlock54

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class RepLockDetectionModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "RepLockDetection"

  @ReactMethod
  fun getDetectionDebug(promise: Promise) {
    try {
      promise.resolve(RepLockDetectionStore.snapshot(reactContext).toString())
    } catch (error: Exception) {
      promise.reject("REPLOCK_DETECTION_READ_FAILED", error)
    }
  }

  @ReactMethod
  fun clearDetectionDebug(promise: Promise) {
    try {
      RepLockDetectionStore.clear(reactContext)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_DETECTION_CLEAR_FAILED", error)
    }
  }

  @ReactMethod
  fun getInstalledLaunchableApps(promise: Promise) {
    try {
      val packageManager = reactContext.packageManager
      val launcherIntent = Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
      val resolveInfos = packageManager.queryIntentActivities(launcherIntent, 0)
      val seenPackages = mutableSetOf<String>()
      val apps = mutableListOf<JSONObject>()

      resolveInfos.forEach { resolveInfo ->
        val packageName = resolveInfo.activityInfo.packageName
        if (packageName == reactContext.packageName || seenPackages.contains(packageName)) {
          return@forEach
        }

        val appInfo = resolveInfo.activityInfo.applicationInfo
        val isSystem = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
          (appInfo.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0
        if (isSystem && !DEFAULT_PROTECTED_PACKAGE_NAMES.contains(packageName)) {
          return@forEach
        }

        val appName = resolveInfo.loadLabel(packageManager)?.toString()?.ifBlank { packageName } ?: packageName
        seenPackages.add(packageName)
        apps.add(
          JSONObject()
            .put("appName", appName)
            .put("packageName", packageName)
            .put("icon", initialsFor(appName))
            .put("isSystem", isSystem)
        )
      }

      val result = JSONArray()
      apps.sortedBy { it.optString("appName").lowercase() }.forEach { result.put(it) }
      promise.resolve(result.toString())
    } catch (error: Exception) {
      promise.reject("REPLOCK_INSTALLED_APPS_FAILED", error)
    }
  }

  @ReactMethod
  fun unlockApp(packageName: String, durationMs: Double, promise: Promise) {
    val reactApplicationContext = reactContext
    var launchIntentFound = false
    var launchMethodUsed = "failed"
    var didMoveRepLockToBack = false
    try {
      RepLockUnlockStore.unlock(reactApplicationContext, packageName, durationMs)
      RepLockDetectionStore.recordUnlock(reactApplicationContext, packageName)
      RepLockDetectionStore.recordUnlockCall(
        reactApplicationContext,
        packageName,
        RepLockUnlockStore.getUnlockedUntil(reactApplicationContext, packageName),
        RepLockUnlockStore.getPostUnlockGraceUntil(reactApplicationContext, packageName),
      )
      RepLockOverlayController.hide()

      val launchIntent = reactApplicationContext.packageManager.getLaunchIntentForPackage(packageName)
      if (launchIntent != null) {
        launchIntentFound = true
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        reactApplicationContext.startActivity(launchIntent)
        launchMethodUsed = "launchIntent"
        RepLockDetectionStore.recordLaunchResult(
          reactApplicationContext,
          packageName,
          launchIntentFound,
          launchMethodUsed,
          true,
          null,
          false,
        )
        promise.resolve(launchResult(packageName, launchMethodUsed, true, null, false).toString())
        return
      }

      val fallbackIntent = Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
        setPackage(packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val fallbackActivity = fallbackIntent.resolveActivity(reactApplicationContext.packageManager)
      if (fallbackActivity != null) {
        reactApplicationContext.startActivity(fallbackIntent)
        launchMethodUsed = "fallbackLauncher"
        RepLockDetectionStore.recordLaunchResult(
          reactApplicationContext,
          packageName,
          launchIntentFound,
          launchMethodUsed,
          true,
          null,
          false,
        )
        promise.resolve(launchResult(packageName, launchMethodUsed, true, null, false).toString())
        return
      }

      didMoveRepLockToBack = moveCurrentActivityToBack()
      launchMethodUsed = if (didMoveRepLockToBack) "moveTaskToBack" else "failed"
      val errorReason = if (didMoveRepLockToBack) null else "No launch intent, no launcher activity, and RepLock activity unavailable"
      RepLockDetectionStore.recordLaunchResult(
        reactApplicationContext,
        packageName,
        launchIntentFound,
        launchMethodUsed,
        didMoveRepLockToBack,
        errorReason,
        didMoveRepLockToBack,
      )

      if (didMoveRepLockToBack) {
        promise.resolve(launchResult(packageName, launchMethodUsed, true, null, true).toString())
      } else {
        promise.reject("REPLOCK_TARGET_LAUNCH_FAILED", errorReason ?: "Target launch failed")
      }
    } catch (error: Exception) {
      val didMoveAfterError = moveCurrentActivityToBack()
      val errorReason = error.message ?: error.javaClass.simpleName
      RepLockDetectionStore.recordLaunchResult(
        reactApplicationContext,
        packageName,
        launchIntentFound,
        if (didMoveAfterError) "moveTaskToBack" else launchMethodUsed,
        didMoveAfterError,
        errorReason,
        didMoveAfterError,
      )
      if (didMoveAfterError) {
        promise.resolve(launchResult(packageName, "moveTaskToBack", true, errorReason, true).toString())
      } else {
        promise.reject("REPLOCK_UNLOCK_FAILED", error)
      }
    }
  }

  @ReactMethod
  fun finishOrMoveTaskToBack(promise: Promise) {
    val didMove = moveCurrentActivityToBack()
    RepLockDetectionStore.recordLaunchResult(
      reactContext,
      "replock",
      false,
      if (didMove) "moveTaskToBack" else "failed",
      didMove,
      if (didMove) null else "RepLock activity unavailable",
      didMove,
    )
    if (didMove) {
      promise.resolve(launchResult("replock", "moveTaskToBack", true, null, true).toString())
    } else {
      promise.reject("REPLOCK_MOVE_TASK_FAILED", "RepLock activity unavailable")
    }
  }

  @ReactMethod
  fun recordChallengeOpened(packageName: String, promise: Promise) {
    try {
      RepLockDetectionStore.recordChallengeOpened(reactContext, packageName)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_CHALLENGE_OPEN_RECORD_FAILED", error)
    }
  }

  private fun moveCurrentActivityToBack(): Boolean {
    val activity: Activity = getCurrentActivity() ?: return false
    return activity.moveTaskToBack(true)
  }

  private fun launchResult(
    packageName: String,
    method: String,
    success: Boolean,
    errorReason: String?,
    didMoveRepLockToBack: Boolean,
  ): JSONObject {
    return JSONObject()
      .put("packageName", packageName)
      .put("launchMethodUsed", method)
      .put("finalLaunchSuccess", success)
      .put("finalLaunchErrorReason", errorReason ?: JSONObject.NULL)
      .put("didMoveRepLockToBack", didMoveRepLockToBack)
  }

  @ReactMethod
  fun cancelChallenge(packageName: String, promise: Promise) {
    try {
      RepLockUnlockStore.cancelChallenge(reactContext, packageName)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_CANCEL_CHALLENGE_FAILED", error)
    }
  }

  @ReactMethod
  fun getActiveUnlockSessions(promise: Promise) {
    try {
      promise.resolve(RepLockUnlockStore.snapshotActiveUnlocks(reactContext).toString())
    } catch (error: Exception) {
      promise.reject("REPLOCK_UNLOCK_SESSIONS_FAILED", error)
    }
  }

  @ReactMethod
  fun setProtectedApps(protectedAppsJson: String, promise: Promise) {
    try {
      RepLockUnlockStore.setProtectedApps(reactContext, protectedAppsJson)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_PROTECTED_APPS_FAILED", error)
    }
  }

  @ReactMethod
  fun setRequiredPushups(requiredPushups: Double, promise: Promise) {
    try {
      RepLockUnlockStore.setRequiredPushups(reactContext, requiredPushups)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_REQUIRED_PUSHUPS_FAILED", error)
    }
  }

  @ReactMethod
  fun isOverlayPermissionGranted(promise: Promise) {
    try {
      val granted = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
        android.provider.Settings.canDrawOverlays(reactContext)
      } else {
        true
      }
      promise.resolve(granted)
    } catch (error: Exception) {
      promise.reject("REPLOCK_OVERLAY_PERMISSION_CHECK_FAILED", error)
    }
  }

  @ReactMethod
  fun openOverlaySettings(promise: Promise) {
    try {
      val intent = android.content.Intent(
        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        android.net.Uri.parse("package:" + reactContext.packageName)
      ).apply {
        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_OVERLAY_SETTINGS_FAILED", error)
    }
  }

  @ReactMethod
  fun openAccessibilitySettings(promise: Promise) {
    try {
      val intent = android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("REPLOCK_ACCESSIBILITY_SETTINGS_FAILED", error)
    }
  }

  private fun initialsFor(appName: String): String {
    return appName
      .split(" ")
      .filter { it.isNotBlank() }
      .take(2)
      .joinToString("") { it.first().uppercaseChar().toString() }
      .ifBlank { "APP" }
      .take(3)
  }

  companion object {
    private val DEFAULT_PROTECTED_PACKAGE_NAMES = setOf(
      "com.zhiliaoapp.musically",
      "com.instagram.android",
      "com.google.android.youtube",
    )
  }
}
`;

const POSE_CAMERA_VIEW_SOURCE = `package com.replock.pushtounlock54

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Size
import android.view.View
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.RCTEventEmitter
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.Pose
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseLandmark
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.sqrt

class RepLockPoseCameraViewManager(
  private val reactContext: ReactApplicationContext
) : SimpleViewManager<RepLockPoseCameraView>() {
  override fun getName(): String = "RepLockPoseCameraView"

  override fun createViewInstance(reactContext: ThemedReactContext): RepLockPoseCameraView {
    return RepLockPoseCameraView(reactContext)
  }

  @ReactProp(name = "cameraFacing")
  fun setCameraFacing(view: RepLockPoseCameraView, cameraFacing: String?) {
    view.setCameraFacing(cameraFacing ?: "front")
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    return mutableMapOf("topPoseUpdate" to mutableMapOf("registrationName" to "onPoseUpdate"))
  }
}

@SuppressLint("ViewConstructor")
class RepLockPoseCameraView(
  private val reactContext: ThemedReactContext
) : FrameLayout(reactContext) {
  private val previewView = PreviewView(reactContext)
  private val overlayView = PoseOverlayView(reactContext)
  private val analyzerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val poseDetector = PoseDetection.getClient(
    PoseDetectorOptions.Builder()
      .setDetectorMode(PoseDetectorOptions.STREAM_MODE)
      .build()
  )
  private var cameraProvider: ProcessCameraProvider? = null
  private var isProcessing = false
  private var isStarted = false
  private var cameraFacing = "front"
  private var lastPoseAt = 0L
  private var fps = 0.0

  init {
    previewView.scaleType = PreviewView.ScaleType.FILL_CENTER
    addView(previewView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(overlayView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setCameraFacing(nextCameraFacing: String) {
    if (cameraFacing == nextCameraFacing) {
      return
    }

    cameraFacing = nextCameraFacing
    if (isStarted) {
      stopCamera()
      startCamera()
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startCamera()
  }

  override fun onDetachedFromWindow() {
    stopCamera()
    super.onDetachedFromWindow()
  }

  private fun startCamera() {
    if (isStarted) {
      return
    }

    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      emitPoseUpdate("Camera permission missing", false, 0, 0.0, 0.0, 0.0)
      return
    }

    val lifecycleOwner = reactContext.currentActivity as? LifecycleOwner
    if (lifecycleOwner == null) {
      emitPoseUpdate("Camera lifecycle unavailable", false, 0, 0.0, 0.0, 0.0)
      return
    }

    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener({
      try {
        cameraProvider = providerFuture.get()
        bindCamera(lifecycleOwner)
        isStarted = true
        emitPoseUpdate("Camera ready", false, 0, fps, 0.0, 0.0)
      } catch (error: Exception) {
        emitPoseUpdate("Camera cannot start", false, 0, fps, 0.0, 0.0)
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun stopCamera() {
    runCatching { cameraProvider?.unbindAll() }
    isStarted = false
    isProcessing = false
  }

  private fun bindCamera(lifecycleOwner: LifecycleOwner) {
    val provider = cameraProvider ?: return
    val preview = Preview.Builder().build().also {
      it.setSurfaceProvider(previewView.surfaceProvider)
    }
    val imageAnalysis = ImageAnalysis.Builder()
      .setTargetResolution(Size(640, 480))
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()
      .also {
        it.setAnalyzer(analyzerExecutor) { imageProxy ->
          analyzeImage(imageProxy)
        }
      }
    val selector = if (cameraFacing == "back") {
      CameraSelector.DEFAULT_BACK_CAMERA
    } else {
      CameraSelector.DEFAULT_FRONT_CAMERA
    }

    provider.unbindAll()
    provider.bindToLifecycle(lifecycleOwner, selector, preview, imageAnalysis)
  }

  @SuppressLint("UnsafeOptInUsageError")
  private fun analyzeImage(imageProxy: ImageProxy) {
    if (isProcessing) {
      imageProxy.close()
      return
    }

    val mediaImage = imageProxy.image
    if (mediaImage == null) {
      imageProxy.close()
      return
    }

    isProcessing = true
    val rotation = imageProxy.imageInfo.rotationDegrees
    val image = InputImage.fromMediaImage(mediaImage, rotation)
    poseDetector.process(image)
      .addOnSuccessListener { pose ->
        handlePose(pose, imageProxy.width, imageProxy.height, rotation)
      }
      .addOnFailureListener {
        reactContext.runOnUiQueueThread {
          overlayView.clearPose()
          emitPoseUpdate("Camera cannot detect pose", false, 0, fps, 0.0, 0.0)
        }
      }
      .addOnCompleteListener {
        isProcessing = false
        imageProxy.close()
      }
  }

  private fun handlePose(pose: Pose, imageWidth: Int, imageHeight: Int, rotation: Int) {
    val now = System.currentTimeMillis()
    if (lastPoseAt > 0L) {
      val instantaneousFps = 1000.0 / max(1L, now - lastPoseAt).toDouble()
      fps = if (fps == 0.0) instantaneousFps else (fps * 0.75) + (instantaneousFps * 0.25)
    }
    lastPoseAt = now

    val landmarks = pose.allPoseLandmarks
    val visibleLandmarks = landmarks.count { it.inFrameLikelihood >= MIN_VISIBLE_CONFIDENCE }
    val fullBodyVisible = REQUIRED_LANDMARKS.all { type ->
      (pose.getPoseLandmark(type)?.inFrameLikelihood ?: 0f) >= MIN_REQUIRED_CONFIDENCE
    }
    val status = when {
      landmarks.isEmpty() -> "Camera cannot detect pose"
      !fullBodyVisible -> "Move further back"
      else -> "Body detected"
    }
    val leftElbowAngle = angleFor(
      pose.getPoseLandmark(PoseLandmark.LEFT_SHOULDER),
      pose.getPoseLandmark(PoseLandmark.LEFT_ELBOW),
      pose.getPoseLandmark(PoseLandmark.LEFT_WRIST),
    )
    val rightElbowAngle = angleFor(
      pose.getPoseLandmark(PoseLandmark.RIGHT_SHOULDER),
      pose.getPoseLandmark(PoseLandmark.RIGHT_ELBOW),
      pose.getPoseLandmark(PoseLandmark.RIGHT_WRIST),
    )

    reactContext.runOnUiQueueThread {
      overlayView.setPose(pose, imageWidth, imageHeight, rotation, cameraFacing == "front")
      emitPoseUpdate(status, fullBodyVisible, visibleLandmarks, fps, leftElbowAngle, rightElbowAngle)
    }
  }

  private fun emitPoseUpdate(
    status: String,
    bodyDetected: Boolean,
    visibleLandmarks: Int,
    fps: Double,
    leftElbowAngle: Double,
    rightElbowAngle: Double,
  ) {
    if (id == View.NO_ID) {
      return
    }

    val event: WritableMap = Arguments.createMap().apply {
      putString("status", status)
      putBoolean("bodyDetected", bodyDetected)
      putInt("visibleLandmarks", visibleLandmarks)
      putDouble("fps", fps)
      putDouble("leftElbowAngle", leftElbowAngle)
      putDouble("rightElbowAngle", rightElbowAngle)
    }
    reactContext.getJSModule(RCTEventEmitter::class.java).receiveEvent(id, "topPoseUpdate", event)
  }

  private fun angleFor(
    first: PoseLandmark?,
    middle: PoseLandmark?,
    last: PoseLandmark?,
  ): Double {
    if (first == null || middle == null || last == null) {
      return 0.0
    }

    val ax = first.position.x - middle.position.x
    val ay = first.position.y - middle.position.y
    val bx = last.position.x - middle.position.x
    val by = last.position.y - middle.position.y
    val dot = (ax * bx) + (ay * by)
    val magA = sqrt((ax * ax) + (ay * ay))
    val magB = sqrt((bx * bx) + (by * by))
    if (magA == 0f || magB == 0f) {
      return 0.0
    }

    val cosine = (dot / (magA * magB)).coerceIn(-1f, 1f)
    return Math.toDegrees(acos(cosine.toDouble()))
  }

  companion object {
    private const val MIN_VISIBLE_CONFIDENCE = 0.35f
    private const val MIN_REQUIRED_CONFIDENCE = 0.35f
    private val REQUIRED_LANDMARKS = listOf(
      PoseLandmark.LEFT_SHOULDER,
      PoseLandmark.RIGHT_SHOULDER,
      PoseLandmark.LEFT_ELBOW,
      PoseLandmark.RIGHT_ELBOW,
      PoseLandmark.LEFT_WRIST,
      PoseLandmark.RIGHT_WRIST,
      PoseLandmark.LEFT_HIP,
      PoseLandmark.RIGHT_HIP,
      PoseLandmark.LEFT_KNEE,
      PoseLandmark.RIGHT_KNEE,
      PoseLandmark.LEFT_ANKLE,
      PoseLandmark.RIGHT_ANKLE,
    )
  }
}

private data class PosePoint(
  val type: Int,
  val x: Float,
  val y: Float,
  val confidence: Float,
)

class PoseOverlayView(context: android.content.Context) : View(context) {
  private val bonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.rgb(45, 212, 191)
    strokeCap = Paint.Cap.ROUND
    strokeWidth = 7f
  }
  private val jointPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    style = Paint.Style.FILL
  }
  private val lowConfidencePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(140, 255, 255, 255)
    style = Paint.Style.FILL
  }
  private var points: List<PosePoint> = emptyList()
  private var imageWidth = 1
  private var imageHeight = 1
  private var rotation = 0
  private var mirror = true

  fun setPose(pose: Pose, sourceWidth: Int, sourceHeight: Int, sourceRotation: Int, shouldMirror: Boolean) {
    points = pose.allPoseLandmarks.map {
      PosePoint(it.landmarkType, it.position.x, it.position.y, it.inFrameLikelihood)
    }
    imageWidth = sourceWidth
    imageHeight = sourceHeight
    rotation = sourceRotation
    mirror = shouldMirror
    invalidate()
  }

  fun clearPose() {
    points = emptyList()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (points.isEmpty()) {
      return
    }

    SKELETON_CONNECTIONS.forEach { connection ->
      val start = points.firstOrNull { it.type == connection.first }
      val end = points.firstOrNull { it.type == connection.second }
      if (start != null && end != null && start.confidence >= 0.35f && end.confidence >= 0.35f) {
        val mappedStart = mapPoint(start)
        val mappedEnd = mapPoint(end)
        canvas.drawLine(mappedStart.first, mappedStart.second, mappedEnd.first, mappedEnd.second, bonePaint)
      }
    }

    points.forEach { point ->
      val mapped = mapPoint(point)
      val paint = if (point.confidence >= 0.35f) jointPaint else lowConfidencePaint
      canvas.drawCircle(mapped.first, mapped.second, 7f, paint)
    }
  }

  private fun mapPoint(point: PosePoint): Pair<Float, Float> {
    val sourceWidth = if (rotation == 90 || rotation == 270) imageHeight.toFloat() else imageWidth.toFloat()
    val sourceHeight = if (rotation == 90 || rotation == 270) imageWidth.toFloat() else imageHeight.toFloat()
    val scale = max(width / sourceWidth, height / sourceHeight)
    val dx = (width - (sourceWidth * scale)) / 2f
    val dy = (height - (sourceHeight * scale)) / 2f
    var x = (point.x * scale) + dx
    val y = (point.y * scale) + dy
    if (mirror) {
      x = width - x
    }
    return Pair(x, y)
  }

  companion object {
    private val SKELETON_CONNECTIONS = listOf(
      PoseLandmark.LEFT_SHOULDER to PoseLandmark.RIGHT_SHOULDER,
      PoseLandmark.LEFT_HIP to PoseLandmark.RIGHT_HIP,
      PoseLandmark.LEFT_SHOULDER to PoseLandmark.LEFT_ELBOW,
      PoseLandmark.LEFT_ELBOW to PoseLandmark.LEFT_WRIST,
      PoseLandmark.RIGHT_SHOULDER to PoseLandmark.RIGHT_ELBOW,
      PoseLandmark.RIGHT_ELBOW to PoseLandmark.RIGHT_WRIST,
      PoseLandmark.LEFT_SHOULDER to PoseLandmark.LEFT_HIP,
      PoseLandmark.RIGHT_SHOULDER to PoseLandmark.RIGHT_HIP,
      PoseLandmark.LEFT_HIP to PoseLandmark.LEFT_KNEE,
      PoseLandmark.LEFT_KNEE to PoseLandmark.LEFT_ANKLE,
      PoseLandmark.RIGHT_HIP to PoseLandmark.RIGHT_KNEE,
      PoseLandmark.RIGHT_KNEE to PoseLandmark.RIGHT_ANKLE,
    )
  }
}
`;

const DETECTION_PACKAGE_SOURCE = `package com.replock.pushtounlock54

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class RepLockDetectionPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(RepLockDetectionModule(reactContext))
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> {
    return listOf(RepLockPoseCameraViewManager(reactContext))
  }
}
`;

const ACCESSIBILITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
  android:accessibilityEventTypes="typeWindowStateChanged"
  android:accessibilityFeedbackType="feedbackGeneric"
  android:accessibilityFlags="flagReportViewIds"
  android:canRetrieveWindowContent="false"
  android:description="@string/replock_accessibility_service_description"
  android:notificationTimeout="100" />
`;

function addRepLockService(androidManifest) {
  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  mainApplication.service = mainApplication.service ?? [];

  const existingService = mainApplication.service.find((service) => {
    return service.$?.['android:name'] === SERVICE_NAME;
  });

  const serviceConfig = existingService ?? {
    $: {
      'android:name': SERVICE_NAME,
      'android:exported': 'true',
      'android:label': SERVICE_LABEL,
      'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
    },
  };

  serviceConfig['intent-filter'] = [
    {
      action: [
        {
          $: {
            'android:name': 'android.accessibilityservice.AccessibilityService',
          },
        },
      ],
    },
  ];

  serviceConfig['meta-data'] = [
    {
      $: {
        'android:name': 'android.accessibilityservice',
        'android:resource': SERVICE_RESOURCE,
      },
    },
  ];

  if (!existingService) {
    mainApplication.service.push(serviceConfig);
  }
}

function addCameraPermission(androidManifest) {
  androidManifest.manifest['uses-permission'] = androidManifest.manifest['uses-permission'] ?? [];
  const permissions = androidManifest.manifest['uses-permission'];
  const hasCameraPermission = permissions.some((permission) => {
    return permission.$?.['android:name'] === 'android.permission.CAMERA';
  });

  if (!hasCameraPermission) {
    permissions.push({
      $: {
        'android:name': 'android.permission.CAMERA',
      },
    });
  }
}

function addRepLockPackageQueries(androidManifest) {
  androidManifest.manifest.queries = androidManifest.manifest.queries ?? [];
  const queries = androidManifest.manifest.queries[0] ?? {};
  queries.package = queries.package ?? [];
  queries.intent = queries.intent ?? [];

  const hasLauncherQuery = queries.intent.some((intent) => {
    return intent.action?.some((action) => action.$?.['android:name'] === 'android.intent.action.MAIN') &&
      intent.category?.some((category) => category.$?.['android:name'] === 'android.intent.category.LAUNCHER');
  });

  if (!hasLauncherQuery) {
    queries.intent.push({
      action: [
        {
          $: {
            'android:name': 'android.intent.action.MAIN',
          },
        },
      ],
      category: [
        {
          $: {
            'android:name': 'android.intent.category.LAUNCHER',
          },
        },
      ],
    });
  }

  LOCKED_PACKAGE_NAMES.forEach((packageName) => {
    const exists = queries.package.some((entry) => entry.$?.['android:name'] === packageName);
    if (!exists) {
      queries.package.push({
        $: {
          'android:name': packageName,
        },
      });
    }
  });

  androidManifest.manifest.queries[0] = queries;
}

function addGradleDependency(contents, dependency) {
  if (contents.includes(dependency)) {
    return contents;
  }

  return contents.replace(
    /dependencies\s*\{/,
    `dependencies {\n    implementation("${dependency}")`
  );
}

function addPoseDependencies(contents) {
  return [
    'androidx.camera:camera-camera2:1.4.2',
    'androidx.camera:camera-lifecycle:1.4.2',
    'androidx.camera:camera-view:1.4.2',
    'com.google.mlkit:pose-detection:18.0.0-beta5',
  ].reduce((nextContents, dependency) => addGradleDependency(nextContents, dependency), contents);
}

function setStringResource(stringsPath) {
  const description =
    'RepLock uses Accessibility permission to detect when selected locked apps are opened so it can require a push-up challenge.';

  if (!fs.existsSync(stringsPath)) {
    fs.mkdirSync(path.dirname(stringsPath), { recursive: true });
    fs.writeFileSync(
      stringsPath,
      `<resources>\n  <string name="replock_accessibility_service_description">${description}</string>\n</resources>\n`
    );
    return;
  }

  const stringsXml = fs.readFileSync(stringsPath, 'utf8');
  if (stringsXml.includes('name="replock_accessibility_service_description"')) {
    return;
  }

  fs.writeFileSync(
    stringsPath,
    stringsXml.replace(
      '</resources>',
      `  <string name="replock_accessibility_service_description">${description}</string>\n</resources>`
    )
  );
}

function patchMainApplication(mainApplicationPath) {
  if (!fs.existsSync(mainApplicationPath)) {
    return;
  }

  const source = fs.readFileSync(mainApplicationPath, 'utf8');
  if (source.includes('RepLockDetectionPackage()')) {
    return;
  }

  fs.writeFileSync(
    mainApplicationPath,
    source.replace(
      '// add(MyReactNativePackage())',
      'add(RepLockDetectionPackage())\n              // add(MyReactNativePackage())'
    )
  );
}

function withRepLockAccessibility(config) {
  config = withAndroidManifest(config, (config) => {
    addCameraPermission(config.modResults);
    addRepLockService(config.modResults);
    addRepLockPackageQueries(config.modResults);
    return config;
  });

  config = withAppBuildGradle(config, (config) => {
    config.modResults.contents = addPoseDependencies(config.modResults.contents);
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      const kotlinDir = path.join(
        androidRoot,
        'app',
        'src',
        'main',
        'java',
        'com',
        'replock',
        'pushtounlock54'
      );
      const xmlDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml');
      const valuesDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'values');

      fs.mkdirSync(kotlinDir, { recursive: true });
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(valuesDir, { recursive: true });

      fs.writeFileSync(path.join(kotlinDir, 'RepLockAccessibilityService.kt'), KOTLIN_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockDetectionStore.kt'), DETECTION_STORE_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockUnlockStore.kt'), UNLOCK_STORE_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockOverlayController.kt'), OVERLAY_CONTROLLER_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockDetectionModule.kt'), DETECTION_MODULE_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockPoseCameraView.kt'), POSE_CAMERA_VIEW_SOURCE);
      fs.writeFileSync(path.join(kotlinDir, 'RepLockDetectionPackage.kt'), DETECTION_PACKAGE_SOURCE);
      fs.writeFileSync(path.join(xmlDir, 'replock_accessibility_service.xml'), ACCESSIBILITY_XML);
      setStringResource(path.join(valuesDir, 'strings.xml'));
      patchMainApplication(path.join(kotlinDir, 'MainApplication.kt'));

      return config;
    },
  ]);

  return config;
}

module.exports = withRepLockAccessibility;
