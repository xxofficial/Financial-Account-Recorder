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
        val config = NativeEmailSyncConfig(
            provider = provider,
            imapHost = call.getString("imapHost", "") ?: "",
            imapPort = call.getInt("imapPort", 993) ?: 993,
            account = call.getString("account", "") ?: "",
            folder = call.getString("folder", "INBOX") ?: "INBOX",
            autoSync = call.getBoolean("autoSync", false) ?: false,
            lastSyncAt = NativeEmailSyncSettings.load(context, provider).lastSyncAt,
            lastStatus = NativeEmailSyncSettings.load(context, provider).lastStatus,
        )
        if (!config.isComplete()) return call.reject("IMAP host, port and account are required")
        val password = call.getString("password")
        if (password.isNullOrBlank() && !SecureSecretStore.has(context, config.passwordKey())) {
            return call.reject("password is required on first configuration")
        }
        NativeEmailSyncSettings.save(context, config, password)
        if (config.autoSync) NativeEmailSyncWorker.schedule(context, provider) else NativeEmailSyncWorker.cancel(context, provider)
        call.resolve(configJson(NativeEmailSyncSettings.load(context, provider)))
    }

    @PluginMethod
    fun syncNow(call: PluginCall) {
        val provider = call.getString("provider")?.uppercase() ?: return call.reject("provider is required")
        Thread {
            runCatching { NativeEmailSyncService.sync(context, provider) }
                .onSuccess { result ->
                    call.resolve(JSObject()
                        .put("scannedCount", result.scannedCount)
                        .put("queuedCount", result.queuedCount)
                        .put("duplicateCount", result.duplicateCount)
                        .put("ignoredCount", result.ignoredCount)
                        .put("latestSeenAt", result.latestSeenAt)
                        .put("message", result.message))
                }
                .onFailure { error -> call.reject(error.message ?: "email sync failed", error as? Exception ?: Exception(error)) }
        }.start()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        Thread {
            val configs = JSArray()
            NativeEmailSyncSettings.configuredProviders(context).forEach { configs.put(configJson(it)) }
            val logs = JSArray()
            NativeInboxDatabase.get(context).dao().recentLogs().forEach { log ->
                logs.put(JSObject().put("id", log.id.toString()).put("provider", log.provider).put("level", log.level).put("message", log.message).put("createdAt", log.createdAt))
            }
            call.resolve(JSObject().put("configs", configs).put("logs", logs))
        }.start()
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        val provider = call.getString("provider")?.uppercase() ?: return call.reject("provider is required")
        NativeEmailSyncSettings.setAutoSync(context, provider, false)
        NativeEmailSyncWorker.cancel(context, provider)
        call.resolve()
    }

    private fun configJson(config: NativeEmailSyncConfig) = JSObject()
        .put("provider", config.provider)
        .put("imapHost", config.imapHost)
        .put("imapPort", config.imapPort)
        .put("account", config.account)
        .put("folder", config.folder)
        .put("autoSync", config.autoSync)
        .put("passwordConfigured", SecureSecretStore.has(context, config.passwordKey()))
        .put("lastSyncAt", config.lastSyncAt)
        .put("lastStatus", config.lastStatus)
}
