// file: src/db.ts
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

export const db = mysql.createPool({
    // ✅ ถ้าอยู่ใน Docker มันจะอ่านค่าจาก environment (ที่เป็น 'db')
    // ✅ ถ้าคุณรันบนเครื่องตัวเอง (Local) มันจะใช้ค่า default ที่เราตั้งหลัง ||
    host: process.env.DB_HOST || '10.33.4.47',
    port: 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'ubuntu@csmsu',
    database: process.env.DB_NAME || 'paas',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

export const checkDbConnection = async () => {
    try {
        const connection = await db.getConnection();
        const [rows]: any = await connection.query("SELECT DATABASE() as dbName");
        // ปริ้นท์บอกหน่อยว่าต่อที่ Host ไหน
        console.log(`✅ Connected to Database "${rows[0].dbName}" at Host: "${process.env.DB_HOST || '10.33.4.47'}" successfully`);
        connection.release();
    } catch (error: any) {
        console.error('❌ Database connection failed:', error.message);
    }
};