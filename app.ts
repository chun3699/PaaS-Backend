import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser"; // 1. เพิ่มบรรทัดนี้

// 1. Import Controller เข้ามา
import { router as portainer } from "./controller/portainer";

export const app = express();

// -----------------------------------------------------
// ตั้งค่า CORS (สำคัญมากสำหรับการใช้ Cookie)
// ถ้าไม่เซ็ต credentials: true บางที Cookie จะส่งไม่ไป
// -----------------------------------------------------
app.use(cors({
    origin: true, // ยอมรับทุกเว็บ (หรือใส่ 'http://localhost:xxxx' ของ Frontend คุณ)
    credentials: true // อนุญาตให้ส่ง Cookie/Token ข้ามมาได้
}));

app.use(cookieParser()); // 2. เพิ่มบรรทัดนี้ (ต้องอยู่ก่อนเรียก /api)

app.use(bodyParser.text());
app.use(bodyParser.json());

// 2. กำหนด Path หลัก
// เวลาเรียกต้องขึ้นต้นด้วย /api แล้วตามด้วย path ใน controller
// เช่น /api/containers/8
app.use("/api", portainer);

app.use("/", (req, res) => {
  res.send("Backend Server Ready! 🚀");
});