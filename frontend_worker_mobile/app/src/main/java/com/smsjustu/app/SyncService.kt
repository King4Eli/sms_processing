package com.smsjustu.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class SyncService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private lateinit var settings: Settings
    private lateinit var notificationManager: NotificationManager

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        notificationManager = getSystemService(NotificationManager::class.java)
        createNotificationChannel()
        EventLog.markStarted(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else 0
        startForeground(NOTIFICATION_ID, buildNotification("Starting…"), type)

        if (loopJob?.isActive != true) {
            loopJob = scope.launch { syncLoop() }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        loopJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        RestartScheduler.scheduleRestart(applicationContext)
        super.onTaskRemoved(rootIntent)
    }

    private suspend fun syncLoop() {
        while (scope.isActive) {
            val token = settings.adminToken
            if (token.isBlank()) {
                notify("Waiting for admin token…")
            } else {
                val powerManager = getSystemService(POWER_SERVICE) as PowerManager
                val wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK, "smsjustu:sync"
                )
                try {
                    wakeLock.acquire(30_000)
                    val workers = AdminApiClient(settings.baseUrl, token).listWorkers()
                    val active = workers.count { it.revokedAt == null }
                    EventLog.recordPull(this@SyncService, workers.size)
                    notify("$active active worker(s) · last synced ${timeNow()} · ${statsLine()}")
                } catch (e: Exception) {
                    EventLog.add(this@SyncService, EventType.ERROR, "Pull failed: ${e.message}")
                    notify("Sync failed: ${e.message} · retrying · ${statsLine()}")
                } finally {
                    if (wakeLock.isHeld) wakeLock.release()
                }
            }
            delay(SYNC_INTERVAL_MS)
        }
    }

    private fun timeNow(): String =
        SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())

    private fun statsLine(): String {
        val stats = EventLog.sessionStats()
        val pulled = EventLog.lastPullCount.value ?: 0
        return "pulled $pulled · sent ${stats.sent} · undelivered ${stats.undelivered}"
    }

    private fun notify(text: String) {
        notificationManager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): android.app.Notification {
        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("smsJustu sync")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Background sync",
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "Keeps the worker list synced in the background"
        }
        notificationManager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "sync_service"
        const val NOTIFICATION_ID = 1001
        const val SYNC_INTERVAL_MS = 60_000L
    }
}
