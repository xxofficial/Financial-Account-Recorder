package com.recoder.stockledger.plugins

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * GitHub Release based updater. A release APK asset must end in its Android
 * versionCode, for example `recoder-v2.0.1-102.apk`; releases without this
 * value are intentionally not offered so versionName never controls updates.
 */
@CapacitorPlugin(name = "AppUpdate")
class AppUpdatePlugin : Plugin() {
    @PluginMethod
    fun check(call: PluginCall) {
        Thread {
            runCatching { latestUpdate() }
                .onSuccess { call.resolve(it) }
                .onFailure { error -> call.reject(error.message ?: "检查更新失败", error as? Exception ?: Exception(error)) }
        }.start()
    }

    @PluginMethod
    fun downloadAndInstall(call: PluginCall) {
        val downloadUrl = call.getString("downloadUrl") ?: return call.reject("downloadUrl is required")
        val assetName = call.getString("assetName") ?: return call.reject("assetName is required")
        if (!downloadUrl.startsWith("https://github.com/")) return call.reject("只接受 GitHub Release APK 下载地址")
        Thread {
            runCatching {
                val apk = downloadApk(downloadUrl, assetName)
                val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                JSObject().put("started", true).put("message", "已交给系统安装器校验签名并安装")
            }.onSuccess { call.resolve(it) }
                .onFailure { error -> call.reject(error.message ?: "下载或安装更新失败", error as? Exception ?: Exception(error)) }
        }.start()
    }

    private fun latestUpdate(): JSObject {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val currentCode = if (android.os.Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else @Suppress("DEPRECATION") packageInfo.versionCode.toLong()
        val currentName = packageInfo.versionName.orEmpty()
        val root = getJson("https://api.github.com/repos/$OWNER/$REPOSITORY/releases/latest")
        val releaseUrl = root.optString("html_url")
        val tag = root.optString("tag_name").trim().trimStart('v', 'V')
        val assets = root.optJSONArray("assets")
        var selected: JSONObject? = null
        var latestCode: Long? = null
        if (assets != null) for (index in 0 until assets.length()) {
            val asset = assets.optJSONObject(index) ?: continue
            val name = asset.optString("name")
            val code = VERSION_CODE_ASSET.find(name)?.groupValues?.getOrNull(1)?.toLongOrNull() ?: continue
            if (!name.endsWith(".apk", true)) continue
            if (latestCode == null || code > latestCode!!) { selected = asset; latestCode = code }
        }
        val result = JSObject()
            .put("currentVersionName", currentName)
            .put("currentVersionCode", currentCode)
            .put("releaseUrl", releaseUrl)
            .put("latestVersionName", tag)
        if (selected == null || latestCode == null) return result
            .put("hasUpdate", false)
            .put("message", "Release 缺少带 versionCode 的 APK（文件名须以 -版本号.apk 结尾）")
        return result
            .put("latestVersionCode", latestCode)
            .put("assetName", selected!!.optString("name"))
            .put("downloadUrl", selected!!.optString("browser_download_url"))
            .put("hasUpdate", latestCode!! > currentCode)
            .put("message", if (latestCode!! > currentCode) "发现新版本" else "已是最新版本")
    }

    private fun getJson(endpoint: String): JSONObject {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000; readTimeout = 20_000; requestMethod = "GET"
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "Recoder-Android")
            setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        }
        try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("检查更新失败：HTTP ${connection.responseCode}")
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }

    private fun downloadApk(endpoint: String, name: String): File {
        val target = File(File(context.cacheDir, "updates").apply { mkdirs() }, name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000; readTimeout = 60_000; requestMethod = "GET"
            setRequestProperty("Accept", "application/octet-stream"); setRequestProperty("User-Agent", "Recoder-Android")
        }
        try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("APK 下载失败：HTTP ${connection.responseCode}")
            connection.inputStream.use { input -> FileOutputStream(target).use { output -> input.copyTo(output) } }
            return target
        } catch (error: Throwable) { target.delete(); throw error } finally { connection.disconnect() }
    }

    private companion object {
        const val OWNER = "xxofficial"
        const val REPOSITORY = "Financial-Account-Recorder"
        val VERSION_CODE_ASSET = Regex("-(\\d+)\\.apk$", RegexOption.IGNORE_CASE)
    }
}
