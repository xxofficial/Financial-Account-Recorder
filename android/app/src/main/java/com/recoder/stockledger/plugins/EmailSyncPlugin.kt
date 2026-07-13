package com.recoder.stockledger.plugins

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.recoder.stockledger.NativeInboxDatabase

@CapacitorPlugin(name = "EmailSync")
class EmailSyncPlugin : Plugin() {
    @PluginMethod
    fun configure(call: PluginCall) {
        val provider = call.getString("provider")?.uppercase() ?: return call.reject("provider is required")
        if (provider !in setOf("ZHUORUI", "SCHWAB")) return call.reject("unsupported provider")
        val mailboxId = call.getString("mailboxId")?.takeIf { it.isNotBlank() } ?: NativeEmailSyncSettings.newId()
        val previous = runCatching { NativeEmailSyncSettings.load(context, mailboxId) }.getOrNull()
        val config = NativeEmailSyncConfig(
            mailboxId = mailboxId, provider = provider,
            imapHost = call.getString("imapHost", "") ?: "", imapPort = call.getInt("imapPort", 993) ?: 993,
            account = call.getString("account", "") ?: "", folder = call.getString("folder", "INBOX") ?: "INBOX",
            autoSync = call.getBoolean("autoSync", false) ?: false,
            lastSyncAt = previous?.lastSyncAt ?: 0L, lastStatus = previous?.lastStatus ?: "未同步",
        )
        if (!config.isComplete()) return call.reject("IMAP host, port and account are required")
        val password = call.getString("password")
        if (password.isNullOrBlank() && !SecureSecretStore.has(context, config.passwordKey())) {
            return call.reject("password is required on first configuration")
        }
        val saved = NativeEmailSyncSettings.save(context, config, password)
        if (saved.autoSync) NativeEmailSyncWorker.schedule(context, saved.mailboxId) else NativeEmailSyncWorker.cancel(context, saved.mailboxId)
        call.resolve(configJson(saved))
    }

    @PluginMethod
    fun syncNow(call: PluginCall) {
        val mailboxId = call.getString("mailboxId") ?: return call.reject("mailboxId is required")
        Thread {
            runCatching { NativeEmailSyncService.sync(context, mailboxId) }
                .onSuccess { result -> call.resolve(JSObject().put("scannedCount", result.scannedCount).put("queuedCount", result.queuedCount).put("duplicateCount", result.duplicateCount).put("ignoredCount", result.ignoredCount).put("latestSeenAt", result.latestSeenAt).put("message", result.message)) }
                .onFailure { error -> call.reject(error.message ?: "email sync failed", error as? Exception ?: Exception(error)) }
        }.start()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        Thread {
            val configs = JSArray(); NativeEmailSyncSettings.configuredMailboxes(context).forEach { configs.put(configJson(it)) }
            val logs = JSArray(); NativeInboxDatabase.get(context).dao().recentLogs().forEach { log ->
                logs.put(JSObject().put("id", log.id.toString()).put("provider", log.provider).put("level", log.level).put("message", log.message).put("createdAt", log.createdAt))
            }
            call.resolve(JSObject().put("configs", configs).put("logs", logs))
        }.start()
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        val mailboxId = call.getString("mailboxId") ?: return call.reject("mailboxId is required")
        val config = runCatching { NativeEmailSyncSettings.load(context, mailboxId) }.getOrElse { return call.reject(it.message ?: "mailbox not found") }
        NativeEmailSyncSettings.save(context, config.copy(autoSync = false), null)
        NativeEmailSyncWorker.cancel(context, mailboxId)
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val mailboxId = call.getString("mailboxId") ?: return call.reject("mailboxId is required")
        NativeEmailSyncWorker.cancel(context, mailboxId)
        NativeEmailSyncSettings.remove(context, mailboxId)
        call.resolve()
    }

    private fun configJson(config: NativeEmailSyncConfig) = JSObject()
        .put("mailboxId", config.mailboxId).put("provider", config.provider)
        .put("imapHost", config.imapHost).put("imapPort", config.imapPort)
        .put("account", config.account).put("folder", config.folder).put("autoSync", config.autoSync)
        .put("passwordConfigured", SecureSecretStore.has(context, config.passwordKey()))
        .put("lastSyncAt", config.lastSyncAt).put("lastStatus", config.lastStatus)
}
