package com.recoder.stockledger.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.Charset

/**
 * Native transport for providers blocked by WebView CORS. Provider parsing stays
 * in TypeScript. Yahoo's short-lived cookie/crumb pair stays in this plugin so
 * it is never exposed to the WebView or persisted to disk.
 */
@CapacitorPlugin(name = "NativeMarket")
class NativeMarketPlugin : Plugin() {
    private data class NativeResponse(
        val status: Int,
        val body: String,
        val headers: Map<String, String>,
    )

    private val yahooAuthLock = Any()

    @Volatile private var yahooCookie: String? = null
    @Volatile private var yahooCrumb: String? = null

    @PluginMethod
    fun request(call: PluginCall) {
        val endpoint = call.getString("url") ?: return call.reject("url is required")
        Thread {
            runCatching {
                val resolvedEndpoint = SecureSecretStore.resolvePlaceholders(context, endpoint)
                val method = call.getString("method", "GET") ?: "GET"
                val timeoutMs = call.getInt("timeoutMs", 15_000) ?: 15_000
                val charset = call.getString("charset", "UTF-8") ?: "UTF-8"
                val headers = mutableMapOf<String, String>()
                val suppliedHeaders = call.getObject("headers")
                suppliedHeaders?.keys()?.let { keys ->
                    while (keys.hasNext()) {
                        val key = keys.next()
                        headers[key] = SecureSecretStore.resolvePlaceholders(context, suppliedHeaders.optString(key).orEmpty())
                    }
                }
                val response = if (isYahooEndpoint(resolvedEndpoint)) {
                    requestYahoo(resolvedEndpoint, method, headers, timeoutMs, charset)
                } else {
                    executeRequest(resolvedEndpoint, method, headers, timeoutMs, charset)
                }
                val responseHeaders = JSObject()
                response.headers.forEach { (key, value) -> responseHeaders.put(key, value) }
                call.resolve(
                    JSObject()
                        .put("status", response.status)
                        .put("body", response.body)
                        .put("headers", responseHeaders),
                )
            }.onFailure { error ->
                call.reject(error.message ?: "Native market request failed", error as? Exception ?: Exception(error))
            }
        }.start()
    }

    private fun isYahooEndpoint(endpoint: String): Boolean =
        endpoint.startsWith("https://query1.finance.yahoo.com/") ||
            endpoint.startsWith("https://query2.finance.yahoo.com/")

    private fun requestYahoo(
        endpoint: String,
        method: String,
        headers: Map<String, String>,
        timeoutMs: Int,
        charset: String,
    ): NativeResponse {
        val firstAuth = yahooAuth() ?: return executeRequest(endpoint, method, headers, timeoutMs, charset)
        val first = executeRequest(
            withYahooCrumb(endpoint, firstAuth.second),
            method,
            headers + ("Cookie" to firstAuth.first),
            timeoutMs,
            charset,
        )
        if (first.status in 200..299) return first

        // Yahoo invalidates these short-lived values without warning. Refresh once,
        // matching the retry behavior of the former native Android implementation.
        clearYahooAuth()
        val retryAuth = yahooAuth() ?: return first
        return executeRequest(
            withYahooCrumb(endpoint, retryAuth.second),
            method,
            headers + ("Cookie" to retryAuth.first),
            timeoutMs,
            charset,
        )
    }

    private fun yahooAuth(): Pair<String, String>? = synchronized(yahooAuthLock) {
        val currentCookie = yahooCookie
        val currentCrumb = yahooCrumb
        if (currentCookie != null && currentCrumb != null) return@synchronized currentCookie to currentCrumb

        val cookie = fetchYahooCookie() ?: return@synchronized null
        val crumb = fetchYahooCrumb(cookie) ?: return@synchronized null
        yahooCookie = cookie
        yahooCrumb = crumb
        cookie to crumb
    }

    private fun clearYahooAuth() = synchronized(yahooAuthLock) {
        yahooCookie = null
        yahooCrumb = null
    }

    private fun fetchYahooCookie(): String? {
        val connection = (URL("https://fc.yahoo.com").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", YAHOO_USER_AGENT)
            setRequestProperty("Accept", "*/*")
        }
        return try {
            // The endpoint may return a redirect or an empty response; either is
            // acceptable if it supplies the A3 session cookie.
            connection.responseCode
            connection.headerFields.entries
                .filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value.orEmpty() }
                .firstOrNull { it.contains("A3=") }
                ?.substringBefore(";")
        } finally {
            connection.disconnect()
        }
    }

    private fun fetchYahooCrumb(cookie: String): String? {
        val response = executeRequest(
            endpoint = "https://query2.finance.yahoo.com/v1/test/getcrumb",
            method = "GET",
            headers = mapOf(
                "User-Agent" to YAHOO_USER_AGENT,
                "Accept" to "*/*",
                "Cookie" to cookie,
            ),
            timeoutMs = 10_000,
            charsetName = "UTF-8",
        )
        return response.body.trim().takeIf { response.status in 200..299 && it.isNotBlank() }
    }

    private fun withYahooCrumb(endpoint: String, crumb: String): String {
        val separator = if (endpoint.contains('?')) "&" else "?"
        return "$endpoint${separator}crumb=${URLEncoder.encode(crumb, Charsets.UTF_8.name())}"
    }

    private fun executeRequest(
        endpoint: String,
        method: String,
        headers: Map<String, String>,
        timeoutMs: Int,
        charsetName: String,
    ): NativeResponse {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = true
            headers.forEach { (key, value) -> setRequestProperty(key, value) }
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charset.forName(charsetName))?.use { it.readText() }.orEmpty()
            // Cookies are transport credentials. Never pass them back through the
            // Capacitor boundary even if a provider includes Set-Cookie in a reply.
            val responseHeaders = connection.headerFields.entries
                .filter { (key, values) -> key != null && !key.equals("Set-Cookie", ignoreCase = true) && !values.isNullOrEmpty() }
                .associate { (key, values) -> key!! to values.joinToString(",") }
            return NativeResponse(status, body, responseHeaders)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val YAHOO_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    }
}
