import axios from "axios";
import mysql from "mysql";

// ==============================
// ส่วนที่ 1: Portainer Connection
// ==============================
// เปลี่ยน IP เป็นของ Portainer คุณ
const PORTAINER_URL = "http://10.33.4.47:9000/api"; 

// ✅ เติม export ตรงนี้ เพื่อให้ไฟล์ routes/api.ts เรียกใช้ได้
export const HOST_IP = "10.33.4.47";

export const portainerConn = axios.create({
  baseURL: PORTAINER_URL,
  // ไม่ต้องใส่ headers Authorization ตรงนี้แล้ว
});


// ==============================
// ส่วนที่ 2: Database Connection
// ==============================
// (ส่วนนี้เหมือนเดิม ยังไม่ต้องแก้)
/*
export const dbConn = mysql.createPool({ ... });
*/