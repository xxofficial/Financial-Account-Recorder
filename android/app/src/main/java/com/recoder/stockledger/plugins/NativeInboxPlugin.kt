package com.recoder.stockledger.plugins

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.recoder.stockledger.NativeImportEntity
import com.recoder.stockledger.NativeInboxDatabase

@CapacitorPlugin(name = "NativeInbox")
class NativeInboxPlugin : Plugin() {
    @PluginMethod
    fun listPending(call: PluginCall) {
        Thread {
            val items = NativeInboxDatabase.get(context).dao().pending()
            val result = JSArray()
            items.forEach { item ->
                result.put(JSObject()
                    .put("id", item.id.toString())
                    .put("source", item.source)
                    .put("platform", item.platform)
                    .put("externalReference", item.externalReference)
                    .put("payload", item.payload)
                    .put("receivedAt", item.receivedAt)
                    .put("status", item.status)
                    .put("message", item.message))
            }
            call.resolve(JSObject().put("items", result))
        }.start()
    }

    @PluginMethod
    fun enqueue(call: PluginCall) {
        val payload = call.getString("payload") ?: return call.reject("payload is required")
        Thread {
            val id = NativeInboxDatabase.get(context).dao().insert(
                NativeImportEntity(
                    source = call.getString("source", "EMAIL") ?: "EMAIL",
                    platform = call.getString("platform", "UNSPECIFIED") ?: "UNSPECIFIED",
                    externalReference = call.getString("externalReference"),
                    payload = payload,
                ),
            )
            call.resolve(JSObject().put("id", id.toString()))
        }.start()
    }

    @PluginMethod
    fun markHandled(call: PluginCall) {
        val id = call.getString("id")?.toLongOrNull() ?: return call.reject("valid id is required")
        val status = call.getString("status") ?: return call.reject("status is required")
        if (status !in setOf("IMPORTED", "DUPLICATE", "FAILED")) return call.reject("invalid status")
        Thread {
            NativeInboxDatabase.get(context).dao().mark(id, status, call.getString("message"))
            call.resolve()
        }.start()
    }
}
