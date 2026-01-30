import http from "http";
import { app } from "./app";
// Import ฟังก์ชัน Login เข้ามา


const port = process.env.port || 3030;
const server = http.createServer(app);

// สั่งรัน Server
server.listen(port, async () => {
  console.log(`Server is started on port ${port}`);


});