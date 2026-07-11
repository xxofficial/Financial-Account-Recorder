package com.recoder.stockledger.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File

/** Text-only PDF extraction. OCR and LLM paths are intentionally absent. */
@CapacitorPlugin(name = "DocumentText")
class DocumentTextPlugin : Plugin() {
    @PluginMethod
    fun extractPdfText(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path is required")
        val password = call.getString("password", "") ?: ""
        Thread {
            runCatching {
                PDDocument.load(File(path), password).use { document ->
                    PDFTextStripper().getText(document)
                }
            }.onSuccess { text ->
                call.resolve(JSObject().put("text", text).put("isEmpty", text.isBlank()))
            }.onFailure { error ->
                call.reject(error.message ?: "PDF text extraction failed", error as? Exception ?: Exception(error))
            }
        }.start()
    }
}
