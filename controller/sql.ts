import express, { Request, Response } from "express";
import { HOST_IP } from "../connection";
import { db } from "../db";
import { RowDataPacket } from "mysql2";

export const router = express.Router();

// --------------------------------------------------------------------------
// สร้าง Database
// --------------------------------------------------------------------------
router.post("/create-db", async (req: Request, res: Response) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: "กรุณาระบุ Username" });

    let connection;
    try {
        // ✅ ใช้ mysql แทน sql
        const [users] = await db.query<RowDataPacket[]>(
            "SELECT password, mysql FROM users WHERE username = ?", 
            [username]
        );

        if (users.length === 0) return res.status(404).json({ success: false, message: "ไม่พบ User" });
        
        // ✅ เช็ค status จาก mysql
        if (users[0].mysql === 1) {
             return res.status(400).json({ success: false, message: "User นี้มี Database อยู่แล้ว" });
        }

        const userPassword = users[0].password;
        // Clean username
        const safeUsername = username.replace(/[^a-zA-Z0-9_]/g, "");
        const dbName = `db_${safeUsername}`;
        const dbUser = safeUsername;

        connection = await db.getConnection();

        // 1. สร้าง Database
        await connection.query(`CREATE DATABASE IF NOT EXISTS ??`, [dbName]);
        
        // 2. สร้าง User และ Reset Password
        await connection.query(`CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${userPassword}'`);
        await connection.query(`ALTER USER '${dbUser}'@'%' IDENTIFIED BY '${userPassword}'`);
        
        // 3. Grant Permission
        await connection.query(`GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'%'`);
        await connection.query("FLUSH PRIVILEGES");

        // ✅ อัปเดตสถานะ mysql = 1
        await connection.query("UPDATE users SET mysql = 1 WHERE username = ?", [username]);

        connection.release();

        res.json({
            success: true,
            message: `สร้าง Database ${dbName} สำเร็จ`,
            credentials: {
                host: HOST_IP,
                port: 3306,
                database: dbName,
                username: dbUser,
                password: userPassword
            }
        });

    } catch (error: any) {
        if (connection) connection.release();
        console.error("Create DB Error:", error);
        res.status(500).json({ success: false, message: "สร้าง Database ไม่สำเร็จ", error: error.message });
    }
});

// --------------------------------------------------------------------------
// ลบ Database
// --------------------------------------------------------------------------
router.delete("/delete-db", async (req: Request, res: Response) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: "กรุณาระบุ Username" });

    let connection;
    try {
        const safeUsername = username.replace(/[^a-zA-Z0-9_]/g, "");
        const dbName = `db_${safeUsername}`;
        const dbUser = safeUsername;

        connection = await db.getConnection();

        // 1. ลบ DB และ User
        await connection.query(`DROP DATABASE IF EXISTS ??`, [dbName]);
        await connection.query(`DROP USER IF EXISTS '${dbUser}'@'%'`);

        // ✅ อัปเดตสถานะ mysql = 0
        await connection.query("UPDATE users SET mysql = 0 WHERE username = ?", [username]);

        connection.release();

        res.json({ success: true, message: `ลบ Database ${dbName} และ User เรียบร้อยแล้ว` });

    } catch (error: any) {
        if (connection) connection.release();
        console.error("Delete DB Error:", error);
        res.status(500).json({ success: false, message: "ลบ Database ไม่สำเร็จ", error: error.message });
    }
});