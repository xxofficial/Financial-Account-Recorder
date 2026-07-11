package com.recoder.stockledger.plugins

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.recoder.stockledger.NativeImportEntity
import com.recoder.stockledger.NativeInboxDatabase
import com.recoder.stockledger.NativeSyncLogEntity
import jakarta.mail.Folder
import jakarta.mail.Message
import jakarta.mail.Multipart
import jakarta.mail.Part
import jakarta.mail.Session
import java.security.MessageDigest
import java.util.Properties
import java.util.concurrent.TimeUnit

private const val EMAIL_PREFS = "recoder_email_sync"
private const val EMAIL_LOOKBACK_MS = 5 * 60 * 1000L
private const val EMAIL_FETCH_LIMIT = 200

data class NativeEmailSyncConfig(
    val provider: String,
    val imapHost: String,
    val imapPort: Int,
    val account: String,
    val folder: String,
    val autoSync: Boolean,
    val lastSyncAt: Long,
    val lastStatus: String,
) {
    fun isComplete() = imapHost.isNotBlank() && imapPort in 1..65535 && account.isNotBlank()
    fun passwordKey() = "email_${provider.lowercase()}_imap_password"
}

object NativeEmailSyncSettings {
    private fun prefs(context: Context) = context.getSharedPreferences(EMAIL_PREFS, Context.MODE_PRIVATE)
    private fun key(provider: String, field: String) = "${provider.lowercase()}.$field"

    fun load(context: Context, provider: String): NativeEmailSyncConfig {
        val normalized = provider.uppercase()
        val values = prefs(context)
        return NativeEmailSyncConfig(
            provider = normalized,
            imapHost = values.getString(key(normalized, "host"), "").orEmpty(),
            imapPort = values.getInt(key(normalized, "port"), 993),
            account = values.getString(key(normalized, "account"), "").orEmpty(),
            folder = values.getString(key(normalized, "folder"), "INBOX").orEmpty().ifBlank { "INBOX" },
            autoSync = values.getBoolean(key(normalized, "auto"), false),
            lastSyncAt = values.getLong(key(normalized, "lastSyncAt"), 0L),
            lastStatus = values.getString(key(normalized, "lastStatus"), "未同步").orEmpty(),
        )
    }

    fun save(context: Context, config: NativeEmailSyncConfig, password: String?) {
        val normalized = config.provider.uppercase()
        prefs(context).edit()
            .putString(key(normalized, "host"), config.imapHost.trim())
            .putInt(key(normalized, "port"), config.imapPort)
            .putString(key(normalized, "account"), config.account.trim())
            .putString(key(normalized, "folder"), config.folder.trim().ifBlank { "INBOX" })
            .putBoolean(key(normalized, "auto"), config.autoSync)
            .apply()
        if (!password.isNullOrBlank()) SecureSecretStore.set(context, config.passwordKey(), password)
    }

    fun setAutoSync(context: Context, provider: String, enabled: Boolean) {
        prefs(context).edit().putBoolean(key(provider, "auto"), enabled).apply()
    }

    fun updateRun(context: Context, provider: String, at: Long, status: String) {
        prefs(context).edit()
            .putLong(key(provider, "lastSyncAt"), at)
            .putString(key(provider, "lastStatus"), status)
            .apply()
    }

    fun configuredProviders(context: Context): List<NativeEmailSyncConfig> =
        listOf("ZHUORUI", "SCHWAB").map { load(context, it) }
}

data class NativeEmailSyncResult(
    val scannedCount: Int,
    val queuedCount: Int,
    val duplicateCount: Int,
    val ignoredCount: Int,
    val latestSeenAt: Long,
    val message: String,
)

object NativeEmailSyncService {
    fun sync(context: Context, provider: String): NativeEmailSyncResult {
        val config = NativeEmailSyncSettings.load(context, provider)
        require(config.isComplete()) { "请先填写完整的 IMAP 地址、端口和账号" }
        val password = SecureSecretStore.readForNative(context, config.passwordKey())
            ?: error("请先保存邮箱密码或应用专用密码")
        val dao = NativeInboxDatabase.get(context).dao()
        val store = Session.getInstance(
            Properties().apply {
                put("mail.store.protocol", "imaps")
                put("mail.imaps.host", config.imapHost)
                put("mail.imaps.port", config.imapPort.toString())
                put("mail.imaps.ssl.enable", "true")
                put("mail.imaps.timeout", "15000")
                put("mail.imaps.connectiontimeout", "15000")
                put("mail.mime.allowutf8", "true")
            },
        ).getStore("imaps")

        try {
            store.connect(config.imapHost, config.imapPort, config.account, password)
            val folder = store.getFolder(config.folder).apply { open(Folder.READ_ONLY) }
            try {
                val total = folder.messageCount
                if (total == 0) return finish(context, config, 0, 0, 0, 0, config.lastSyncAt, "同步完成：邮箱没有邮件")
                val start = (total - EMAIL_FETCH_LIMIT + 1).coerceAtLeast(1)
                val threshold = (config.lastSyncAt - EMAIL_LOOKBACK_MS).coerceAtLeast(0L)
                var scanned = 0
                var queued = 0
                var duplicates = 0
                var ignored = 0
                var latest = config.lastSyncAt
                folder.getMessages(start, total).sortedBy { messageTimestamp(it) }.forEach { message ->
                    val timestamp = messageTimestamp(message)
                    latest = maxOf(latest, timestamp)
                    if (timestamp < threshold) return@forEach
                    scanned += 1
                    val subject = runCatching { message.subject }.getOrDefault("")
                    val from = runCatching { message.from?.joinToString(" ") { it.toString() }.orEmpty() }.getOrDefault("")
                    val body = extractText(message).trim()
                    if (!isRelevant(config.provider, from, subject, body)) {
                        ignored += 1
                        return@forEach
                    }
                    val externalReference = message.getHeader("Message-ID")?.firstOrNull()?.trim().orEmpty()
                        .ifBlank { stableReference(config.provider, subject, body, timestamp) }
                    if (dao.hasEmailReference(config.provider, externalReference)) {
                        duplicates += 1
                        return@forEach
                    }
                    dao.insert(
                        NativeImportEntity(
                            source = "EMAIL",
                            platform = config.provider,
                            externalReference = externalReference,
                            payload = org.json.JSONObject()
                                .put("text", listOf(subject, body).filter { it.isNotBlank() }.joinToString("\n\n"))
                                .put("from", from)
                                .put("receivedAt", timestamp)
                                .toString(),
                            receivedAt = timestamp,
                        ),
                    )
                    queued += 1
                }
                return finish(context, config, scanned, queued, duplicates, ignored, latest, "同步完成：扫描 $scanned 封，待确认 $queued 封，重复 $duplicates 封")
            } finally {
                runCatching { folder.close(false) }
            }
        } catch (error: Throwable) {
            NativeEmailSyncSettings.updateRun(context, config.provider, config.lastSyncAt, "同步失败：${error.message ?: "IMAP 连接异常"}")
            dao.addLog(NativeSyncLogEntity(provider = config.provider, level = "ERROR", message = "同步失败：${error.message ?: "IMAP 连接异常"}"))
            throw error
        } finally {
            runCatching { store.close() }
        }
    }

    private fun finish(
        context: Context,
        config: NativeEmailSyncConfig,
        scanned: Int,
        queued: Int,
        duplicates: Int,
        ignored: Int,
        latest: Long,
        message: String,
    ): NativeEmailSyncResult {
        NativeEmailSyncSettings.updateRun(context, config.provider, latest, message)
        NativeInboxDatabase.get(context).dao().addLog(NativeSyncLogEntity(provider = config.provider, level = "INFO", message = message))
        return NativeEmailSyncResult(scanned, queued, duplicates, ignored, latest, message)
    }

    private fun messageTimestamp(message: Message): Long =
        message.receivedDate?.time ?: message.sentDate?.time ?: System.currentTimeMillis()

    private fun isRelevant(provider: String, from: String, subject: String, text: String): Boolean = when (provider.uppercase()) {
        "ZHUORUI" -> text.contains("成功买入证券") || text.contains("成功卖出证券")
        "SCHWAB" -> (from.contains("schwab", ignoreCase = true) || subject.contains("schwab", ignoreCase = true)) &&
            text.contains("schwab econfirms", ignoreCase = true)
        else -> false
    }

    private fun stableReference(provider: String, subject: String, body: String, timestamp: Long): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest("$provider|$subject|$body|$timestamp".toByteArray())
        return "$provider-${bytes.take(12).joinToString("") { "%02x".format(it) }}"
    }

    private fun extractText(part: Part): String {
        if (part.disposition.equals(Part.ATTACHMENT, ignoreCase = true)) return ""
        return when {
            part.isMimeType("text/plain") -> part.content?.toString().orEmpty()
            part.isMimeType("text/html") -> part.content?.toString().orEmpty()
                .replace(Regex("<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>", RegexOption.IGNORE_CASE), " ")
                .replace(Regex("<[^>]+>"), " ")
                .replace("&nbsp;", " ")
                .replace(Regex("\\s+"), " ")
            part.isMimeType("multipart/*") -> {
                val multipart = part.content as? Multipart ?: return ""
                (0 until multipart.count).joinToString("\n") { index -> extractText(multipart.getBodyPart(index)) }
            }
            else -> ""
        }
    }
}

class NativeEmailSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val provider = inputData.getString("provider") ?: return Result.failure()
        return runCatching { NativeEmailSyncService.sync(applicationContext, provider) }
            .fold(onSuccess = { Result.success() }, onFailure = { Result.retry() })
    }

    companion object {
        private fun name(provider: String) = "recoder-email-sync-${provider.lowercase()}"

        fun schedule(context: Context, provider: String) {
            val request = PeriodicWorkRequestBuilder<NativeEmailSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(Data.Builder().putString("provider", provider.uppercase()).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(name(provider), ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun cancel(context: Context, provider: String) {
            WorkManager.getInstance(context).cancelUniqueWork(name(provider))
        }
    }
}
