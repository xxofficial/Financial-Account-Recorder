package com.recoder.stockledger

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "native_import_inbox")
data class NativeImportEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val source: String,
    val platform: String,
    val externalReference: String? = null,
    val payload: String,
    val receivedAt: Long = System.currentTimeMillis(),
    val status: String = "PENDING",
    val message: String? = null,
)

@Entity(tableName = "native_sync_log")
data class NativeSyncLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val provider: String,
    val level: String,
    val message: String,
    val createdAt: Long = System.currentTimeMillis(),
)

@Dao
interface NativeInboxDao {
    @Query("SELECT * FROM native_import_inbox WHERE status = 'PENDING' ORDER BY receivedAt ASC")
    fun pending(): List<NativeImportEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(entity: NativeImportEntity): Long

    @Query("SELECT EXISTS(SELECT 1 FROM native_import_inbox WHERE source = 'EMAIL' AND platform = :platform AND externalReference = :externalReference)")
    fun hasEmailReference(platform: String, externalReference: String): Boolean

    @Query("UPDATE native_import_inbox SET status = :status, message = :message WHERE id = :id")
    fun mark(id: Long, status: String, message: String?): Int

    @Insert
    fun addLog(entry: NativeSyncLogEntity): Long

    @Query("SELECT * FROM native_sync_log ORDER BY createdAt DESC LIMIT :limit")
    fun recentLogs(limit: Int = 30): List<NativeSyncLogEntity>
}

@Database(entities = [NativeImportEntity::class, NativeSyncLogEntity::class], version = 2, exportSchema = false)
abstract class NativeInboxDatabase : RoomDatabase() {
    abstract fun dao(): NativeInboxDao

    companion object {
        @Volatile private var instance: NativeInboxDatabase? = null

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "CREATE TABLE IF NOT EXISTS `native_sync_log` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `provider` TEXT NOT NULL, `level` TEXT NOT NULL, `message` TEXT NOT NULL, `createdAt` INTEGER NOT NULL)",
                )
            }
        }

        fun get(context: Context): NativeInboxDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, NativeInboxDatabase::class.java, "native-inbox.db")
                .addMigrations(MIGRATION_1_2)
                .build()
                .also { instance = it }
        }
    }
}
