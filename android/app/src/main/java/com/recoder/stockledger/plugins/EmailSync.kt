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
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val EMAIL_PREFS = "recoder_email_sync"
private const val CONFIGS_KEY = "mailboxes_v2"
private const val EMAIL_LOOKBACK_MS = 5 * 60 * 1000L
private const val EMAIL_FETCH_LIMIT = 200
private val SUPPORTED_PROVIDERS = setOf("ZHUORUI", "SCHWAB")

data class NativeEmailSyncConfig(
    val mailboxId: String,
    val provider: String,
    val imapHost: String,
    val imapPort: Int,
    val account: String,
    val folder: String,
    val autoSync: Boolean,
    val lastSyncAt: Long,
    val lastStatus: String,
) {
    fun isComplete() = provider in SUPPORTED_PROVIDERS && imapHost.isNotBlank() && imapPort in 1..65535 && account.isNotBlank()
    fun passwordKey() = "email_${mailboxId}_imap_password"
}

object NativeEmailSyncSettings {
    private fun prefs(context: Context) = context.getSharedPreferences(EMAIL_PREFS, Context.MODE_PRIVATE)
    private fun legacyKey(provider: String, field: String) = "${provider.lowercase()}.$field"

    private fun fromJson(value: JSONObject) = NativeEmailSyncConfig(
        mailboxId = value.optString("mailboxId"),
        provider = value.optString("provider").uppercase(),
        imapHost = value.optString("imapHost"),
        imapPort = value.optInt("imapPort", 993),
        account = value.optString("account"),
        folder = value.optString("folder", "INBOX").ifBlank { "INBOX" },
        autoSync = value.optBoolean("autoSync", false),
        lastSyncAt = value.optLong("lastSyncAt", 0L),
        lastStatus = value.optString("lastStatus", "未同步"),
    )

    private fun toJson(config: NativeEmailSyncConfig) = JSONObject()
        .put("mailboxId", config.mailboxId)
        .put("provider", config.provider)
        .put("imapHost", config.imapHost)
        .put("imapPort", config.imapPort)
        .put("account", config.account)
        .put("folder", config.folder)
        .put("autoSync", config.autoSync)
        .put("lastSyncAt", config.lastSyncAt)
        .put("lastStatus", config.lastStatus)

    private fun saveAll(context: Context, configs: List<NativeEmailSyncConfig>) {
        val serialized = JSONArray()
        configs.forEach { serialized.put(toJson(it)) }
        prefs(context).edit().putString(CONFIGS_KEY, serialized.toString()).apply()
    }

    private fun migrateLegacy(context: Context) {
        val values = prefs(context)
        if (values.contains(CONFIGS_KEY)) return
        val migrated = SUPPORTED_PROVIDERS.mapNotNull { provider ->
            val host = values.getString(legacyKey(provider, "host"), "").orEmpty()
            val account = values.getString(legacyKey(provider, "account"), "").orEmpty()
            if (host.isBlank() && account.isBlank()) return@mapNotNull null
            val config = NativeEmailSyncConfig(
                mailboxId = "legacy-${provider.lowercase()}", provider = provider, imapHost = host,
                imapPort = values.getInt(legacyKey(provider, "port"), 993), account = account,
                folder = values.getString(legacyKey(provider, "folder"), "INBOX").orEmpty().ifBlank { "INBOX" },
                autoSync = values.getBoolean(legacyKey(provider, "auto"), false),
                lastSyncAt = values.getLong(legacyKey(provider, "lastSyncAt"), 0L),
                lastStatus = values.getString(legacyKey(provider, "lastStatus"), "未同步").orEmpty(),
            )
            SecureSecretStore.readForNative(context, "email_${provider.lowercase()}_imap_password")?.let {
                SecureSecretStore.set(context, config.passwordKey(), it)
            }
            config
        }
        saveAll(context, migrated)
    }

    fun configuredMailboxes(context: Context): List<NativeEmailSyncConfig> {
        migrateLegacy(context)
        return runCatching { JSONArray(prefs(context).getString(CONFIGS_KEY, "[]")) }.getOrDefault(JSONArray())
            .let { array -> (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let(::fromJson) } }
            .filter { it.mailboxId.isNotBlank() && it.provider in SUPPORTED_PROVIDERS }
    }

    fun load(context: Context, mailboxId: String): NativeEmailSyncConfig =
        configuredMailboxes(context).firstOrNull { it.mailboxId == mailboxId }
            ?: error("邮箱配置不存在")

    fun save(context: Context, config: NativeEmailSyncConfig, password: String?): NativeEmailSyncConfig {
        require(config.isComplete()) { "IMAP host, port and account are required" }
        val normalized = config.copy(
            provider = config.provider.uppercase(),
            imapHost = config.imapHost.trim(), account = config.account.trim(),
            folder = config.folder.trim().ifBlank { "INBOX" },
        )
        val configs = configuredMailboxes(context).filterNot { it.mailboxId == normalized.mailboxId } + normalized
        saveAll(context, configs)
        if (!password.isNullOrBlank()) SecureSecretStore.set(context, normalized.passwordKey(), password)
        return normalized
    }

    fun updateRun(context: Context, mailboxId: String, at: Long, status: String) {
        val configs = configuredMailboxes(context).map {
            if (it.mailboxId == mailboxId) it.copy(lastSyncAt = at, lastStatus = status) else it
        }
        saveAll(context, configs)
    }

    fun remove(context: Context, mailboxId: String) {
        val config = configuredMailboxes(context).firstOrNull { it.mailboxId == mailboxId }
        if (config != null) SecureSecretStore.clear(context, config.passwordKey())
        saveAll(context, configuredMailboxes(context).filterNot { it.mailboxId == mailboxId })
    }

    fun newId() = UUID.randomUUID().toString()
}

data class NativeEmailSyncResult(
    val scannedCount: Int, val queuedCount: Int, val duplicateCount: Int,
    val ignoredCount: Int, val latestSeenAt: Long, val message: String,
)

object NativeEmailSyncService {
    fun sync(context: Context, mailboxId: String): NativeEmailSyncResult {
        val config = NativeEmailSyncSettings.load(context, mailboxId)
        require(config.isComplete()) { "请先填写完整的 IMAP 地址、端口和账号" }
        val password = SecureSecretStore.readForNative(context, config.passwordKey())
            ?: error("请先保存邮箱密码或应用专用密码")
        val dao = NativeInboxDatabase.get(context).dao()
        val store = Session.getInstance(Properties().apply {
            put("mail.store.protocol", "imaps"); put("mail.imaps.host", config.imapHost)
            put("mail.imaps.port", config.imapPort.toString()); put("mail.imaps.ssl.enable", "true")
            put("mail.imaps.timeout", "15000"); put("mail.imaps.connectiontimeout", "15000"); put("mail.mime.allowutf8", "true")
        }).getStore("imaps")
        try {
            store.connect(config.imapHost, config.imapPort, config.account, password)
            val folder = store.getFolder(config.folder).apply { open(Folder.READ_ONLY) }
            try {
                val total = folder.messageCount
                if (total == 0) return finish(context, config, 0, 0, 0, 0, config.lastSyncAt, "同步完成：邮箱没有邮件")
                val start = (total - EMAIL_FETCH_LIMIT + 1).coerceAtLeast(1)
                val threshold = (config.lastSyncAt - EMAIL_LOOKBACK_MS).coerceAtLeast(0L)
                var scanned = 0; var queued = 0; var duplicates = 0; var ignored = 0; var latest = config.lastSyncAt
                folder.getMessages(start, total).sortedBy { messageTimestamp(it) }.forEach { message ->
                    val timestamp = messageTimestamp(message); latest = maxOf(latest, timestamp)
                    if (timestamp < threshold) return@forEach
                    scanned += 1
                    val subject = runCatching { message.subject }.getOrDefault("")
                    val from = runCatching { message.from?.joinToString(" ") { it.toString() }.orEmpty() }.getOrDefault("")
                    val body = extractText(message).trim()
                    if (!isRelevant(config.provider, from, subject, body)) { ignored += 1; return@forEach }
                    val rawReference = message.getHeader("Message-ID")?.firstOrNull()?.trim().orEmpty()
                        .ifBlank { stableReference(config.provider, subject, body, timestamp) }
                    val externalReference = "${config.mailboxId}:$rawReference"
                    if (dao.hasEmailReference(config.provider, externalReference)) { duplicates += 1; return@forEach }
                    dao.insert(NativeImportEntity(
                        source = "EMAIL", platform = config.provider, externalReference = externalReference,
                        payload = JSONObject().put("text", listOf(subject, body).filter { it.isNotBlank() }.joinToString("\n\n"))
                            .put("from", from).put("receivedAt", timestamp).put("mailboxId", config.mailboxId).toString(),
                        receivedAt = timestamp,
                    ))
                    queued += 1
                }
                return finish(context, config, scanned, queued, duplicates, ignored, latest, "同步完成：扫描 $scanned 封，待确认 $queued 封，重复 $duplicates 封")
            } finally { runCatching { folder.close(false) } }
        } catch (error: Throwable) {
            val message = "同步失败：${error.message ?: "IMAP 连接异常"}"
            NativeEmailSyncSettings.updateRun(context, config.mailboxId, config.lastSyncAt, message)
            dao.addLog(NativeSyncLogEntity(provider = config.provider, level = "ERROR", message = message))
            throw error
        } finally { runCatching { store.close() } }
    }

    private fun finish(context: Context, config: NativeEmailSyncConfig, scanned: Int, queued: Int, duplicates: Int, ignored: Int, latest: Long, message: String): NativeEmailSyncResult {
        NativeEmailSyncSettings.updateRun(context, config.mailboxId, latest, message)
        NativeInboxDatabase.get(context).dao().addLog(NativeSyncLogEntity(provider = config.provider, level = "INFO", message = message))
        return NativeEmailSyncResult(scanned, queued, duplicates, ignored, latest, message)
    }
    private fun messageTimestamp(message: Message): Long = message.receivedDate?.time ?: message.sentDate?.time ?: System.currentTimeMillis()
    private fun isRelevant(provider: String, from: String, subject: String, text: String): Boolean = when (provider.uppercase()) {
        "ZHUORUI" -> text.contains("成功买入证券") || text.contains("成功卖出证券")
        "SCHWAB" -> (from.contains("schwab", true) || subject.contains("schwab", true)) && text.contains("schwab econfirms", true)
        else -> false
    }
    private fun stableReference(provider: String, subject: String, body: String, timestamp: Long): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest("$provider|$subject|$body|$timestamp".toByteArray())
        return "$provider-${bytes.take(12).joinToString("") { "%02x".format(it) }}"
    }
    private fun extractText(part: Part): String {
        if (part.disposition.equals(Part.ATTACHMENT, true)) return ""
        return when {
            part.isMimeType("text/plain") -> part.content?.toString().orEmpty()
            part.isMimeType("text/html") -> part.content?.toString().orEmpty().replace(Regex("<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>", RegexOption.IGNORE_CASE), " ").replace(Regex("<[^>]+>"), " ").replace("&nbsp;", " ").replace(Regex("\\s+"), " ")
            part.isMimeType("multipart/*") -> (part.content as? Multipart)?.let { multipart -> (0 until multipart.count).joinToString("\n") { extractText(multipart.getBodyPart(it)) } }.orEmpty()
            else -> ""
        }
    }
}

class NativeEmailSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val mailboxId = inputData.getString("mailboxId") ?: return Result.failure()
        return runCatching { NativeEmailSyncService.sync(applicationContext, mailboxId) }.fold({ Result.success() }, { Result.retry() })
    }
    companion object {
        private fun name(mailboxId: String) = "recoder-email-sync-$mailboxId"
        fun schedule(context: Context, mailboxId: String) {
            val request = PeriodicWorkRequestBuilder<NativeEmailSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(Data.Builder().putString("mailboxId", mailboxId).build()).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(name(mailboxId), ExistingPeriodicWorkPolicy.UPDATE, request)
        }
        fun cancel(context: Context, mailboxId: String) { WorkManager.getInstance(context).cancelUniqueWork(name(mailboxId)) }
    }
}
