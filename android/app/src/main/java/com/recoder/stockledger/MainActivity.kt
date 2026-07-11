package com.recoder.stockledger

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.recoder.stockledger.plugins.DocumentTextPlugin
import com.recoder.stockledger.plugins.AppUpdatePlugin
import com.recoder.stockledger.plugins.EmailSyncPlugin
import com.recoder.stockledger.plugins.NativeInboxPlugin
import com.recoder.stockledger.plugins.NativeMarketPlugin
import com.recoder.stockledger.plugins.SecureSecretPlugin
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import org.json.JSONObject
import java.io.File

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativeMarketPlugin::class.java)
        registerPlugin(SecureSecretPlugin::class.java)
        registerPlugin(NativeInboxPlugin::class.java)
        registerPlugin(DocumentTextPlugin::class.java)
        registerPlugin(EmailSyncPlugin::class.java)
        registerPlugin(AppUpdatePlugin::class.java)
        super.onCreate(savedInstanceState)
        PDFBoxResourceLoader.init(applicationContext)
        consumeSharedIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeSharedIntent(intent)
    }

    private fun consumeSharedIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        when {
            intent.type?.startsWith("text/") == true -> {
                val text = listOf(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT))
                    .filterNotNull().joinToString("\n\n").trim()
                if (text.isNotBlank()) {
                    Thread {
                        NativeInboxDatabase.get(applicationContext).dao().insert(
                            NativeImportEntity(source = "SHARED_TEXT", platform = "UNSPECIFIED", payload = JSONObject().put("text", text).toString()),
                        )
                    }.start()
                }
            }
            intent.type == "application/pdf" || intent.type == "application/octet-stream" -> {
                @Suppress("DEPRECATION")
                val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
                val file = copySharedFile(uri) ?: return
                Thread {
                    NativeInboxDatabase.get(applicationContext).dao().insert(
                        NativeImportEntity(source = "PDF", platform = "UNSPECIFIED", payload = JSONObject().put("path", file.absolutePath).put("name", file.name).toString()),
                    )
                }.start()
            }
        }
        intent.action = Intent.ACTION_MAIN
        intent.type = null
        intent.removeExtra(Intent.EXTRA_TEXT)
        intent.removeExtra(Intent.EXTRA_STREAM)
    }

    private fun copySharedFile(uri: Uri): File? = runCatching {
        val source = contentResolver.openInputStream(uri) ?: return null
        val target = File(cacheDir, "shared-${System.currentTimeMillis()}.pdf")
        source.use { input -> target.outputStream().use { input.copyTo(it) } }
        target
    }.getOrNull()
}
