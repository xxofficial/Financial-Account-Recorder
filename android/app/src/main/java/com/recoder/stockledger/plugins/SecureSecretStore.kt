package com.recoder.stockledger.plugins

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The WebView can ask whether a value exists and can replace it, but it never
 * receives persisted secret material. NativeMarket resolves placeholders at
 * request time inside the Android process.
 */
object SecureSecretStore {
    private const val PREFERENCE_NAME = "recoder_secure_secrets"
    private const val KEY_ALIAS = "recoder-platform-secrets"
    private val placeholder = Regex("__RECORDER_SECRET_([A-Za-z0-9_-]+)__")

    fun has(context: Context, key: String): Boolean =
        context.getSharedPreferences(PREFERENCE_NAME, Context.MODE_PRIVATE).contains(key)

    fun set(context: Context, key: String, value: String) {
        context.getSharedPreferences(PREFERENCE_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(key, encrypt(value))
            .apply()
    }

    fun clear(context: Context, key: String) {
        context.getSharedPreferences(PREFERENCE_NAME, Context.MODE_PRIVATE).edit().remove(key).apply()
    }

    /** For native workers only; no Capacitor method exposes this value to the WebView. */
    fun readForNative(context: Context, key: String): String? = read(context, key)

    fun resolvePlaceholders(context: Context, value: String): String = placeholder.replace(value) { match ->
        val key = match.groupValues[1]
        read(context, key) ?: throw IllegalStateException("Android secure secret is missing: $key")
    }

    private fun read(context: Context, key: String): String? {
        val encoded = context.getSharedPreferences(PREFERENCE_NAME, Context.MODE_PRIVATE).getString(key, null) ?: return null
        return decrypt(encoded)
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val bytes = ByteBuffer.allocate(1 + cipher.iv.size + encrypted.size)
            .put(cipher.iv.size.toByte())
            .put(cipher.iv)
            .put(encrypted)
            .array()
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.isNotEmpty()) { "Encrypted secret is empty" }
        val ivLength = bytes[0].toInt() and 0xff
        require(ivLength in 12 until bytes.size) { "Encrypted secret is malformed" }
        val iv = bytes.copyOfRange(1, 1 + ivLength)
        val ciphertext = bytes.copyOfRange(1 + ivLength, bytes.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }
}
