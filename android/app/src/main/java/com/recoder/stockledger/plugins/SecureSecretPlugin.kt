package com.recoder.stockledger.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SecureSecret")
class SecureSecretPlugin : Plugin() {
    @PluginMethod
    fun has(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        call.resolve(JSObject().put("exists", SecureSecretStore.has(context, key)))
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        val value = call.getString("value") ?: return call.reject("value is required")
        runCatching { SecureSecretStore.set(context, key, value) }
            .onSuccess { call.resolve() }
            .onFailure { call.reject(it.message ?: "Unable to save secret", it as? Exception ?: Exception(it)) }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        SecureSecretStore.clear(context, key)
        call.resolve()
    }
}
