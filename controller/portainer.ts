import express from "express";
import { portainerConn, HOST_IP } from "../connection";
import { db } from "../db";
import FormData from "form-data";
import axios from "axios";

export const router = express.Router();

// ==========================================
// 🛠️ ฟังก์ชันช่วย: ดึง Token จาก Cookie (แก้ใหม่)
// ==========================================
const getAuthHeader = (req: express.Request) => {
  // เปลี่ยนจาก req.headers.authorization มาอ่านจาก Cookie แทน
  // หมายเหตุ: req.cookies มาจาก cookie-parser
  const token = (req as any).cookies?.portainer_token; 
  
  if (!token) {
    throw new Error("No token provided");
  }
  
  // Portainer ต้องการ "Bearer <token>"
  return `Bearer ${token}`;
};

// ==========================================
// 🔑 Route: LOGIN (POST) (แก้ใหม่)
// ==========================================
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "กรุณาระบุ username และ password" });
    }

    // ยิงไปขอ Token จาก Portainer
    const response = await portainerConn.post("/auth", {
      Username: username,
      Password: password
    });

    const token = response.data.jwt;

    console.log(`✅ User: ${username} Login สำเร็จ (ฝัง Cookie)`);
    
    // --- จุดเปลี่ยนสำคัญ: ฝัง Token ลง Cookie ---
    res.cookie('portainer_token', token, {
        httpOnly: true, // ป้องกัน JavaScript ขโมย Token
        maxAge: 8 * 60 * 60 * 1000, // 8 ชั่วโมง
        // secure: true, // เปิดบรรทัดนี้ถ้าขึ้น Server จริงที่เป็น HTTPS
        // sameSite: 'strict' 
    });

    // ส่งแค่ข้อความบอกว่าสำเร็จ (ไม่ต้องส่ง Token ให้ user เห็นแล้ว)
    res.json({ message: "Login successful" });

  } catch (error: any) {
    console.error("❌ Login failed:", error.message);
    res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  }
});

// ==========================================
// 🌐 Route: Get Environments (ดึงจาก SQL)
// แก้ไข: ดึงจาก DB แทน Portainer เพื่อให้ ID ตรงกับระบบจอง Port
// ==========================================
router.get("/environmentsql", async (req, res) => {
  try {
    // ดึงจากตาราง environments ของเราเอง
    const [rows] = await db.query("SELECT * FROM environments");
    res.json(rows);
  } catch (error: any) {
    console.error("❌ Error fetching environments:", error.message);
    res.status(500).json({ error: "ดึงข้อมูลไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 📦 Route: Get Containers (อัตโนมัติ)
// ==========================================
router.get("/containers/:id", async (req, res) => {
  try {
    // 1. ดึง Token จาก Cookie อัตโนมัติ (ผ่านฟังก์ชันที่เราแก้)
    const authHeader = getAuthHeader(req);
    
    const envId = req.params.id;

    // 2. ยิงไป Portainer
    const response = await portainerConn.get(`/endpoints/${envId}/docker/containers/json?all=1`, {
      headers: { Authorization: authHeader } 
    });
    
    const containers = response.data.map((c: any) => ({
        id: c.Id.substring(0, 12),
        names: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status
    }));

    console.log(`✅ ดึง Container (Env: ${envId}) สำเร็จ`);
    res.json(containers);

  } catch (error: any) {
    // เช็ค Error ถ้าไม่มี Token ใน Cookie
    if (error.message === "No token provided" || error.response?.status === 401) {
      return res.status(401).json({ error: "กรุณา Login ก่อน (Unauthorized)" });
    }
    
    if (error.response && error.response.status === 404) {
        return res.status(404).json({ error: "ไม่พบ Environment ID นี้" });
    }

    console.error("❌ Error:", error.message);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล", details: error.message });
  }
});

// ==========================================
// 🌐 Route: Get Environments (อัตโนมัติ)
// ==========================================
router.get("/environments", async (req, res) => {
  try {
    // 1. ดึง Token จาก Cookie อัตโนมัติ
    const authHeader = getAuthHeader(req);

    // 2. ยิง Portainer
    const response = await portainerConn.get('/endpoints', {
        headers: { Authorization: authHeader }
    });

    const environments = response.data.map((env: any) => ({
      id: env.Id,
      name: env.Name,
      url: env.URL,
      type: env.Type,
      status: env.Status === 1 ? "Up" : "Down"
    }));

    console.log(`✅ ดึง Environments สำเร็จ`);
    res.json(environments);

  } catch (error: any) {
     if (error.message === "No token provided" || error.response?.status === 401) {
      return res.status(401).json({ error: "Unauthorized: กรุณา Login ก่อน" });
    }
    console.error("❌ Error fetching environments:", error.message);
    res.status(500).json({ error: "ไม่สามารถดึงรายชื่อ Environment ได้", details: error.message });
  }
});

// ==========================================
// ✏️ Route: Edit Environment (เปลี่ยนชื่อ/IP)
// เรียก: PUT http://localhost:3000/api/environments/:id
// Body: { "name": "Project-2568", "url": "tcp://192.168.137.145:2376" }
// ==========================================
router.put("/environments/:id", async (req, res) => {
  try {
    // 1. ดึง Token จาก Cookie
    const authHeader = getAuthHeader(req);
    const envId = req.params.id; // รับ ID ของ Environment ที่จะแก้
    
    // 2. รับค่าที่ต้องการแก้จาก Body
    const { name, url } = req.body;

    if (!name && !url) {
      return res.status(400).json({ error: "กรุณาระบุ name หรือ url ที่ต้องการแก้ไข" });
    }

    // 3. เตรียมข้อมูลสำหรับส่งให้ Portainer
    // Portainer API ต้องการ key เป็นตัวพิมพ์ใหญ่ (Name, URL)
    const payload: any = {};
    if (name) payload.Name = name;
    
    // หมายเหตุ: URL ของ Docker ต้องมี tcp:// นำหน้าเสมอถ้าเชื่อมผ่าน IP
    if (url) {
        // เช็คว่าผู้ใช้ลืมใส่ tcp:// หรือไม่ ถ้าลืมให้เติมให้
        payload.URL = url.startsWith("tcp://") ? url : `tcp://${url}`;
    }
    
    // ถ้าจะย้าย Group ไป Unassigned ให้ใส่ GroupId: 1 (ค่า Default ของ Portainer)
    // payload.GroupId = 1; 

    // 4. ยิง Request ไป Update ที่ Portainer
    const response = await portainerConn.put(`/endpoints/${envId}`, payload, {
        headers: { Authorization: authHeader }
    });

    console.log(`✅ แก้ไข Environment ID: ${envId} สำเร็จ`);
    res.json({
        message: "Update successful",
        data: response.data
    });

  } catch (error: any) {
    if (error.message === "No token provided" || error.response?.status === 401) {
      return res.status(401).json({ error: "Unauthorized: กรุณา Login ก่อน" });
    }
    
    console.error("❌ Error updating environment:", error.message);
    res.status(500).json({ error: "แก้ไขข้อมูลไม่สำเร็จ", details: error.message });
  }
});


// ==========================================
// 🏢 Create Team
// ==========================================
router.post("/teams", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { name } = req.body;

    if (!name) return res.status(400).json({ error: "Name is required" });

    // 1. Portainer
    const portainerRes = await portainerConn.post("/teams", { Name: name }, { headers: { Authorization: authHeader } });
    const newTeamId = portainerRes.data.Id;
    console.log(`✅ Portainer Team Created: ${name} (ID: ${newTeamId})`);

    // 2. SQL
    await db.query("INSERT INTO teams (portainer_team_id, name) VALUES (?, ?)", [newTeamId, name]);
    console.log(`✅ SQL Team Saved`);

    res.status(201).json({ message: "สร้างทีมสำเร็จ", teamId: newTeamId, name });

  } catch (error: any) {
    console.error("❌ Error creating team:", error.message);
    res.status(500).json({ error: "สร้างทีมไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 🗑️ Route: Remove User from Team (เตะออกจากทีม)
// หน้าที่: ลบ Membership ใน Portainer และตั้งค่า Team เป็น NULL ใน SQL
// ==========================================
router.delete("/users/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { userId } = req.body; // รับ userId (Portainer ID) ที่จะเตะออก

    if (!userId) {
      return res.status(400).json({ error: "กรุณาระบุ userId" });
    }

    console.log(`⏳ Removing User ID ${userId} from team...`);

    // 1. ลบ Membership ใน Portainer (เพื่อตัดสิทธิ์การมองเห็นทันที)
    try {
        // ดึงรายการ Membership ของ User คนนี้มาก่อน
        const membershipsRes = await portainerConn.get(`/users/${userId}/memberships`, {
            headers: { Authorization: authHeader }
        });

        // วนลูปสั่งลบทุก Membership ทิ้ง (ให้ User กลายเป็นคนไร้สังกัด)
        for (const membership of membershipsRes.data) {
            await portainerConn.delete(`/team_memberships/${membership.Id}`, {
                headers: { Authorization: authHeader }
            });
        }
    } catch (e: any) {
        console.warn(`⚠️ Portainer Membership Cleanup Failed (อาจจะไม่มีอยู่แล้ว): ${e.message}`);
    }

    // 2. อัปเดต SQL: ตั้งค่า Team เป็น NULL (ค่าว่าง) ตามที่ต้องการ
    await db.query(
      "UPDATE users SET portainer_team_id = NULL WHERE portainer_user_id = ?", 
      [userId]
    );

    console.log(`✅ User ${userId} removed from team (Set to NULL)`);
    res.json({ message: "นำนิสิตออกจากทีมสำเร็จ" });

  } catch (error: any) {
    console.error("❌ Remove Member Error:", error.message);
    res.status(500).json({ error: "นำออกจากทีมไม่สำเร็จ", details: error.message });
  }
});


// ==========================================
// 🗑️ Route: Delete Team (Transaction Mode + Unlink)
// แก้ปัญหา: ตัดความสัมพันธ์กับ Env/User ก่อนลบ เพื่อไม่ให้ติด Cascade/Restrict
// ==========================================
router.delete("/teams/:id", async (req, res) => {
  // ขอ Connection แยกเพื่อทำ Transaction (สำคัญมาก)
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction(); // เริ่มต้นกระบวนการ

    const authHeader = getAuthHeader(req);
    const teamId = req.params.id; // รับ ID (id_team)

    console.log(`🔥 Start Deleting Team SQL ID: ${teamId}`);

    if (!teamId || teamId === 'undefined') {
        throw new Error("Invalid Team ID received (ID is undefined)");
    }

    // 1. หาข้อมูลทีมก่อน (เพื่อเอา Portainer Team ID)
    const [teamRows]: any = await connection.query("SELECT * FROM teams WHERE id_team = ?", [teamId]);
    
    if (teamRows.length === 0) {
        connection.release(); // คืน Connection
        return res.status(404).json({ error: "ไม่พบทีมนี้ในระบบ" });
    }
    
    const team = teamRows[0];
    const portainerTeamId = team.portainer_team_id;
    console.log(`   - Found Team: ${team.name} (Portainer ID: ${portainerTeamId})`);

    // 2. ลบทีมใน Portainer (ถ้ามี)
    if (portainerTeamId) {
        try {
            await portainerConn.delete(`/teams/${portainerTeamId}`, {
                headers: { Authorization: authHeader }
            });
            console.log(`   - ✅ [Portainer] Deleted Team ID: ${portainerTeamId}`);
        } catch (e: any) {
            console.warn(`   - ⚠️ [Portainer] Delete Failed (Skipped): ${e.message}`);
        }
    }

    // 3. 🛡️ ตัดความสัมพันธ์ใน SQL (Unlink Foreign Keys)
    // ต้องทำก่อนสั่ง DELETE teams เสมอ เพื่อหยุดลูกโซ่ Cascade
    if (portainerTeamId) {
        // 3.1 ปลด User (ตั้งทีมเป็น NULL)
        const [userRes]: any = await connection.query(
            "UPDATE users SET portainer_team_id = NULL WHERE portainer_team_id = ?", 
            [portainerTeamId]
        );
        console.log(`   - 🧹 Unlinked ${userRes.affectedRows} users from team`);

        // 3.2 ปลด Environment (ตั้งทีมเป็น NULL) 
        // *จุดสำคัญ:* พอเป็น NULL แล้ว ตอนลบทีม มันจะไม่พยายามไปลบ Env ทำให้ไม่ติด Project Restrict
        const [envRes]: any = await connection.query(
            "UPDATE environments SET portainer_team_id = NULL WHERE portainer_team_id = ?", 
            [portainerTeamId]
        );
        console.log(`   - 🧹 Unlinked ${envRes.affectedRows} environments from team`);
    }

    // 4. ลบทีมออกจาก SQL
    await connection.query("DELETE FROM teams WHERE id_team = ?", [teamId]);
    console.log(`   - ✅ [SQL] Deleted team record`);

    await connection.commit(); // ยืนยันการทำงานทั้งหมด
    res.json({ message: `ลบทีม ${team.name} สำเร็จ` });

  } catch (error: any) {
    await connection.rollback(); // ย้อนกลับถ้าระเบิด
    console.error("❌ Delete Team Error:", error.message);
    res.status(500).json({ error: "ลบทีมไม่สำเร็จ", details: error.message });
  } finally {
    connection.release(); // คืน Connection เสมอ
  }
});



// ==========================================
// 👤 Create User (Team is Optional / Nullable)
// ==========================================
router.post("/users", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    // teamId เป็น optional (อาจจะเป็น undefined หรือ null)
    const { username, password, teamId } = req.body;

    if (!username || !password) return res.status(400).json({ error: "User/Pass required" });

    // --- เช็ค Team ใน SQL (ทำเฉพาะตอนที่ส่ง teamId มาเท่านั้น) ---
    if (teamId) {
        const [rows]: any = await db.query("SELECT id_team FROM teams WHERE portainer_team_id = ?", [teamId]);
        if (rows.length === 0) {
            return res.status(400).json({ error: `ไม่พบ Team ID ${teamId} ในระบบ` });
        }
    }

    // --- STEP 1: Portainer Create User ---
    const roleId = 2; 
    const userRes = await portainerConn.post("/users", { 
        Username: username, 
        Password: password, 
        Role: roleId 
    }, { headers: { Authorization: authHeader } });
    
    const newUserId = userRes.data.Id;
    console.log(`✅ User Created: ${username} (ID: ${newUserId})`);

    // --- STEP 2: Add to Team (ทำเฉพาะตอนที่ส่ง teamId มา) ---
    if (teamId) {
      try {
        await portainerConn.post("/team_memberships", {
          UserID: newUserId, TeamID: teamId, Role: 2 
        }, { headers: { Authorization: authHeader } });
        console.log(`✅ Added to Team ID: ${teamId}`);
      } catch (e: any) {
        console.error("⚠️ Failed to add team membership:", e.message);
      }
    }

    // --- STEP 3: SQL Save (Handle NULL teamId) ---
    try {
      const sql = "INSERT INTO users (portainer_user_id, username, password, role, portainer_team_id) VALUES (?, ?, ?, ?, ?)";
      
      // ถ้า teamId ไม่มีค่า ให้ส่ง null เข้าไป
      await db.query(sql, [newUserId, username, password, roleId, teamId || null]);
      
      console.log(`✅ SQL User Saved (Team: ${teamId || 'NULL'})`);

    } catch (sqlError: any) {
      return res.status(500).json({ error: "User created but SQL failed", details: sqlError.message });
    }

    res.status(201).json({ 
        message: "สร้างผู้ใช้สำเร็จ", 
        userId: newUserId, 
        teamId: teamId || null 
    });

  } catch (error: any) {
    if (error.response?.status === 409) return res.status(409).json({ error: "ชื่อซ้ำ" });
    res.status(500).json({ error: "Error creating user", details: error.message });
  }
});

// ==========================================
// 🗑️ Delete User (Both Portainer & SQL)
// ==========================================
router.delete("/users/:id", async (req, res) => {
    // รับค่า id ที่ส่งมา (ซึ่งคือ id_users ในฐานข้อมูลเรา)
    const localUserId = req.params.id;

    try {
        // 🔹 1. ค้นหาข้อมูลจาก SQL ก่อน (เพื่อเอา portainer_user_id)
        // ⚠️ ต้องใช้ WHERE id_users นะครับ ตามตารางของคุณ
        const [rows]: any = await db.query("SELECT * FROM users WHERE id_users = ?", [localUserId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "ไม่พบ User นี้ในระบบ" });
        }

        const targetUser = rows[0];
        const portainerUserId = targetUser.portainer_user_id; // ดึง ID ของ Portainer ออกมา

        // 🔹 2. ลบ User ใน Portainer (ถ้ามี ID)
        // เราใช้ try-catch ครอบตรงนี้ เพื่อให้ถ้าลบใน Portainer ไม่เจอ ก็ยังไปลบใน SQL ต่อได้
        if (portainerUserId) {
            try {
                const authHeader = getAuthHeader(req); // 🔑 ใช้ฟังก์ชันเดิมของคุณดึง Token

                await portainerConn.delete(`/users/${portainerUserId}`, {
                    headers: { Authorization: authHeader }
                });

                console.log(`✅ Deleted Portainer User ID: ${portainerUserId}`);
            } catch (portainerError: any) {
                // ถ้า Error 404 แปลว่าไม่มี user นี้ใน portainer แล้ว (ช่างมัน)
                // แต่ถ้า Error อื่นให้แจ้งเตือนไว้
                if (portainerError.response?.status !== 404) {
                    console.warn(`⚠️ Failed to delete from Portainer: ${portainerError.message}`);
                }
            }
        }

        // 🔹 3. ลบออกจาก SQL Database ของเรา
        // ⚠️ ใช้ id_users เป็นเงื่อนไข
        const [result]: any = await db.query("DELETE FROM users WHERE id_users = ?", [localUserId]);

        if (result.affectedRows === 0) {
            return res.status(500).json({ error: "ลบข้อมูลใน SQL ไม่สำเร็จ" });
        }

        console.log(`✅ SQL User Deleted (ID: ${localUserId})`);

        res.status(200).json({
            message: "ลบผู้ใช้สำเร็จ",
            deletedId: localUserId,
            portainerDeleted: !!portainerUserId
        });

    } catch (error: any) {
        console.error("❌ Error deleting user:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบ", details: error.message });
    }
});

// ==========================================
// 📋 Route: Get All Teams (ดูทีมทั้งหมด)
// ==========================================
router.get("/teams", async (req, res) => {
  try {
    // ดึงข้อมูลทีมทั้งหมดจากตาราง teams
    const [rows] = await db.query("SELECT * FROM teams");
    
    res.json(rows);

  } catch (error: any) {
    console.error("❌ Error fetching teams:", error.message);
    res.status(500).json({ error: "ดึงข้อมูลทีมไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 📋 Route: Get All Teams (ดูทีมทั้งหมด)
// ==========================================
router.get("/teams", async (req, res) => {
  try {
    // ดึงข้อมูลทีมทั้งหมด
    const [rows] = await db.query("SELECT * FROM teams");
    res.json(rows);

  } catch (error: any) {
    console.error("❌ Error fetching teams:", error.message);
    res.status(500).json({ error: "ดึงข้อมูลทีมไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 👥 Route: Get All Users (แก้ชื่อ Column ให้ตรงรูปภาพ)
// ==========================================
router.get("/users", async (req, res) => {
  try {
    // ⚠️ แก้ตรงนี้: เปลี่ยน users.id เป็น users.id_users
    const sql = `
      SELECT 
        users.id_users, 
        users.portainer_user_id,
        users.username,
        users.role,
        users.portainer_team_id,
        teams.name AS team_name
      FROM users
      LEFT JOIN teams ON users.portainer_team_id = teams.portainer_team_id
    `;

    const [rows] = await db.query(sql);
    res.json(rows);

  } catch (error: any) {
    console.error("❌ Error fetching users:", error.message);
    res.status(500).json({ error: "ดึงข้อมูล User ไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 🔄 Route: Change Team (รับ userId และ teamId ผ่าน Body)
// เรียก: PUT /api/users/team
// Body: { "userId": 15, "teamId": 2 }
// ==========================================
router.put("/users/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    
    // 1. รับค่าจาก Body ทั้งคู่ (แก้ตรงนี้)
    const { userId, teamId } = req.body;

    if (!userId || !teamId) {
      return res.status(400).json({ error: "กรุณาระบุ userId และ teamId ใน Body" });
    }

    // 2. ตรวจสอบว่า Team ID มีใน SQL จริงไหม
    const [teams]: any = await db.query("SELECT * FROM teams WHERE portainer_team_id = ?", [teamId]);
    if (teams.length === 0) {
      return res.status(404).json({ error: `ไม่พบ Team ID ${teamId} ในระบบ` });
    }

    console.log(`⏳ กำลังย้าย User ID ${userId} ไปยัง Team ID ${teamId}...`);

    // -----------------------------------------------------
    // STEP 3: Portainer - ล้างทีมเก่าทิ้งให้หมด (Reset)
    // -----------------------------------------------------
    // ดึง Membership เก่ามาดู
    const membershipsRes = await portainerConn.get(`/users/${userId}/memberships`, {
      headers: { Authorization: authHeader }
    });

    // วนลูปสั่งลบ Membership เก่าทุกอัน
    for (const membership of membershipsRes.data) {
      await portainerConn.delete(`/team_memberships/${membership.Id}`, {
        headers: { Authorization: authHeader }
      });
    }

    // -----------------------------------------------------
    // STEP 4: Portainer - ใส่เข้าทีมใหม่
    // -----------------------------------------------------
    await portainerConn.post("/team_memberships", {
      UserID: userId,
      TeamID: teamId,
      Role: 2 // Regular User
    }, { headers: { Authorization: authHeader } });

    console.log(`✅ Portainer: ย้ายทีมสำเร็จ`);

    // -----------------------------------------------------
    // STEP 5: SQL - อัปเดตข้อมูล
    // -----------------------------------------------------
    await db.query(
      "UPDATE users SET portainer_team_id = ? WHERE portainer_user_id = ?", 
      [teamId, userId]
    );

    console.log(`✅ SQL: อัปเดตข้อมูลสำเร็จ`);

    res.json({ 
      message: "ย้ายทีมสำเร็จ", 
      userId: userId, 
      newTeamId: teamId 
    });

  } catch (error: any) {
    console.error("❌ Error changing team:", error.message);
    res.status(500).json({ error: "ไม่สามารถย้ายทีมได้", details: error.message });
  }
});


// ==========================================
// 1. สร้าง Environment (JSON Mode - PascalCase)
// แก้ปัญหา: เปลี่ยน key เป็นตัวใหญ่ตามที่ Portainer ต้องการ
// ==========================================
router.post("/environments", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    let { name } = req.body; 

    if (!name) return res.status(400).json({ error: "กรุณาระบุ name" });
    name = name.trim();

    // ------------------------------------------------------------------
    // 📦 1. เตรียม FormData (แปลงทุกอย่างเป็น String เหมือน Postman)
    // ------------------------------------------------------------------
    const form = new FormData();
    form.append('Name', name);                   
    form.append('URL', 'unix:///var/run/docker.sock'); 
    form.append('EndpointCreationType', '1');   // ส่งเป็น String '1'
    form.append('TLS', 'false');                // ส่งเป็น String 'false'

    // ------------------------------------------------------------------
    // 📏 2. คำนวณขนาด (จำเป็นมากสำหรับ Portainer)
    // ------------------------------------------------------------------
    const length = await new Promise<number>((resolve, reject) => {
        form.getLength((err, len) => {
            if (err) reject(err);
            else resolve(len);
        });
    });

    // ------------------------------------------------------------------
    // 🔧 3. ดึง Header และจัดระเบียบใหม่ (แก้ปัญหา Content-Type ตีกัน)
    // ------------------------------------------------------------------
    const formHeaders = form.getHeaders(); 
    
    console.log(`-------------------------------------------`);
    console.log(`🏗️ Creating: ${name}`);
    console.log(`📡 Sending Content-Type: ${formHeaders['content-type']}`); // เช็คดูว่า Boundary มาไหม
    console.log(`-------------------------------------------`);

    // 🚀 ยิง Portainer
    const createRes = await portainerConn.post('/endpoints', form, {
      headers: { 
          'Authorization': authHeader,
          // 🔥 บังคับใช้ Content-Type จาก form-data เท่านั้น (แก้ปัญหา Axios ใส่ application/json)
          'Content-Type': formHeaders['content-type'], 
          'Content-Length': length
      }
    });

    console.log(`✅ Success! Created ID: ${createRes.data.Id}`);

    // Save DB...
    const sql = "INSERT INTO environments (portainer_endpoint_id, name, url, portainer_team_id) VALUES (?, ?, ?, NULL)";
    await db.query(sql, [createRes.data.Id, name, 'unix:///var/run/docker.sock']);

    res.status(201).json({
        message: "สร้าง Environment สำเร็จ",
        endpointId: createRes.data.Id,
        name: name
    });

  } catch (error: any) {
    if (error.response) {
        console.error("🔴 Portainer Reject:", JSON.stringify(error.response.data));
        return res.status(error.response.status).json({ 
            error: "Portainer ปฏิเสธ", 
            details: error.response.data,
            hint: "Content-Type mismatch confirmed. Check logs for Boundary."
        });
    }
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: "Server Error", details: error.message });
  }
});


// ==========================================
// 3. ลบ Environment (Final Fix 🔧)
// แก้ชื่อตารางจาก projects -> project
// แก้ชื่อคอลัมน์จาก environment_id -> environment
// ==========================================
router.delete("/environments/:id", async (req, res) => {
  const connection = await db.getConnection(); 
  try {
    await connection.beginTransaction(); 

    const authHeader = getAuthHeader(req);
    const id = req.params.id;

    console.log(`🗑️ Processing Delete for Environment ID: ${id}`);

    // 1. หาข้อมูล Environment
    const [rows]: any = await connection.query("SELECT * FROM environments WHERE id = ?", [id]);
    
    if (rows.length === 0) {
        connection.release();
        return res.status(404).json({ error: "ไม่พบ Environment ในฐานข้อมูล" });
    }

    const portainerId = rows[0].portainer_endpoint_id;

    // -----------------------------------------------------------------------
    // 🧠 Step 1: เคลียร์ Stack ใน Portainer (Smart Filter)
    // -----------------------------------------------------------------------
    try {
        const stacksRes = await portainerConn.get(`/stacks?filters={"EndpointID":${portainerId}}`, {
             headers: { Authorization: authHeader }
        });
        const stacks = stacksRes.data;

        // รายชื่อห้ามลบ
        const protectedStacks = ["my-paas-project", "production-mysql", "portainer"];

        for (const stack of stacks) {
            if (protectedStacks.includes(stack.Name)) {
                console.log(`🛡️ SKIP: ไม่ลบ System Stack -> ${stack.Name}`);
                continue; 
            }
            console.log(`🧨 Deleting Stack: ${stack.Name} (ID: ${stack.Id})`);
            await portainerConn.delete(`/stacks/${stack.Id}?endpointId=${portainerId}`, {
                headers: { Authorization: authHeader }
            });
        }
    } catch (err: any) {
        console.warn(`⚠️ Warning stack cleanup: ${err.message}`);
    }

    // -----------------------------------------------------------------------
    // 🗑️ Step 2: ลบ Endpoint ใน Portainer
    // -----------------------------------------------------------------------
    try {
        await portainerConn.delete(`/endpoints/${portainerId}`, {
            headers: { Authorization: authHeader }
        });
        console.log(`✅ [Portainer] Deleted Endpoint ID: ${portainerId}`);
    } catch (err: any) {
        console.warn(`⚠️ [Portainer] Delete Endpoint Warning: ${err.message}`);
    }

    // -----------------------------------------------------------------------
    // 🧹 Step 3: เคลียร์ DB (ต้องลบลูกก่อนแม่เสมอ!)
    // -----------------------------------------------------------------------
    try {
         // 🔥 จุดแก้ไข: แก้ชื่อตารางและคอลัมน์ให้ตรงกับ Error
         // ตาราง: project (ไม่มี s)
         // คอลัมน์: environment (ตาม Error ที่ฟ้อง foreign key)
        const [delProj]: any = await connection.query("DELETE FROM project WHERE environment = ?", [id]);
        console.log(`✅ [SQL] Deleted ${delProj.affectedRows} projects.`);
    } catch (e: any) {
        console.warn(`⚠️ [SQL] Warning deleting projects: ${e.message}`);
        // ถ้าลบ project ไม่ได้ อาจจะเพราะไม่มีตาราง หรือชื่อผิดอีก ให้ throw error ออกไปเลย
        throw e; 
    }

    // ลบตัวแม่ (Environment)
    await connection.query("DELETE FROM environments WHERE id = ?", [id]);
    console.log(`✅ [SQL] Deleted environment record ID: ${id}`);

    await connection.commit(); 
    res.json({ message: `ลบ Environment ID ${id} และ Project ที่เกี่ยวข้องสำเร็จ` });

  } catch (error: any) {
    await connection.rollback(); 
    console.error("❌ Delete Error:", error.message);
    
    // ส่ง Error กลับไปให้ชัดเจน
    res.status(500).json({ 
        error: "ลบไม่สำเร็จ", 
        details: error.message,
        hint: "เช็คชื่อตาราง project หรือ foreign key อีกครั้ง"
    });
  } finally {
    connection.release();
  }
});



// ==========================================
// 🔄 Route: Assign/Update Team (Strict Move Mode)
// Param: id (ID ของ environment เป้าหมายที่จะย้ายทีมไปใส่)
// Body: { "teamId": 3 } 
// Concept: 1 ทีม มีเครื่องได้แค่ 1 เครื่อง (ถ้ามีเครื่องเก่าอยู่ จะถูกเตะออกทันที)
// ==========================================
router.put("/environments/:id/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const envId = req.params.id;      // ID ของเครื่องใหม่
    const { teamId } = req.body;      // ID ของทีมที่จะย้ายมา

    // 1. 🔍 หา Environment เป้าหมายก่อน
    const [envRows]: any = await db.query("SELECT * FROM environments WHERE id = ?", [envId]);
    if (envRows.length === 0) {
      return res.status(404).json({ error: "ไม่พบ Environment นี้ในระบบ" });
    }
    const targetEnv = envRows[0];

    // 2. 🔍 เช็คว่า Team มีอยู่จริงไหม
    if (teamId) {
        const [teamRows]: any = await db.query("SELECT * FROM teams WHERE portainer_team_id = ?", [teamId]);
        if (teamRows.length === 0) {
            return res.status(404).json({ error: `ไม่พบ Team ID ${teamId} ในระบบ` });
        }

        // =========================================================
        // 🚀 STRICT MOVE LOGIC: เคลียร์บ้านเก่า (ถ้ามี)
        // =========================================================
        // หาว่าทีมนี้สิงอยู่ที่เครื่องอื่นมาก่อนไหม? (ที่ไม่ใช่เครื่องปัจจุบัน)
        const [oldEnvs]: any = await db.query(
            "SELECT * FROM environments WHERE portainer_team_id = ? AND id != ?", 
            [teamId, envId]
        );

        if (oldEnvs.length > 0) {
            console.log(`🚚 Team ${teamId} กำลังย้ายเครื่อง... (พบเครื่องเก่า ${oldEnvs.length} เครื่อง)`);
            
            for (const oldEnv of oldEnvs) {
                // 2.1 ปลดสิทธิ์ใน Portainer (เครื่องเก่า) -> ให้กลายเป็น Admin Only
                try {
                    console.log(`   - กำลังปลดสิทธิ์ออกจาก: ${oldEnv.name} (Endpoint ID: ${oldEnv.portainer_endpoint_id})`);
                    await portainerConn.put(`/endpoints/${oldEnv.portainer_endpoint_id}`, 
                        { TeamAccessPolicies: {} }, // ส่ง Object ว่าง = ล้างสิทธิ์ทีมออก
                        { headers: { Authorization: authHeader } }
                    );
                } catch (e: any) { 
                    console.error(`   ❌ ปลดสิทธิ์ Portainer พลาด (${oldEnv.name}):`, e.message); 
                    // (ทำต่อ ไม่ต้อง return error เพราะเราต้องเคลียร์ SQL ต่อ)
                }

                // 2.2 ลบ ID ทีมออกจาก SQL (เครื่องเก่า) ให้เป็น NULL
                await db.query("UPDATE environments SET portainer_team_id = NULL WHERE id = ?", [oldEnv.id]);
                console.log(`   ✅ เคลียร์ SQL เครื่องเก่า (${oldEnv.name}) เรียบร้อย`);
            }
        }
        // =========================================================
    }

    // 3. 🔐 อัปเดตสิทธิ์ให้เครื่องใหม่ (Target)
    const accessPayload = {
        TeamAccessPolicies: teamId ? { [`${teamId}`]: { RoleId: 0 } } : {}
    };

    console.log(`🔄 Updating Target "${targetEnv.name}" to Team ID: ${teamId || "Unassigned"}`);
    
    try {
        await portainerConn.put(`/endpoints/${targetEnv.portainer_endpoint_id}`, accessPayload, {
            headers: { Authorization: authHeader }
        });
        console.log("✅ Target Portainer Access Updated");
    } catch (err: any) {
        console.error("❌ Failed to update Portainer access:", err.message);
        return res.status(500).json({ error: "อัปเดตสิทธิ์ใน Portainer ไม่สำเร็จ", details: err.message });
    }

    // 4. 💾 อัปเดต SQL เครื่องใหม่
    await db.query("UPDATE environments SET portainer_team_id = ? WHERE id = ?", [teamId || null, envId]);
    console.log("✅ Target SQL Updated");

    res.json({ 
        message: "ย้ายทีมสำเร็จ (เคลียร์เครื่องเก่าให้แล้ว)", 
        environment: targetEnv.name, 
        newTeamId: teamId || "Unassigned" 
    });

  } catch (error: any) {
    console.error("❌ Move Team Error:", error.message);
    res.status(500).json({ error: "ดำเนินการไม่สำเร็จ", details: error.message });
  }
});


// Config เริ่มต้น
const BASE_PROJECT_PORT = 4000; 

// ==========================================
// 2. ขอ Port/Project (เริ่มที่ 4000)
// Input: { "environmentId": 1, "userId": 101, "amount": 1 }
// ==========================================
router.post("/projects", async (req, res) => {
  try {
    const { environmentId, userId, amount } = req.body;

    // --- Validation ---
    if (!environmentId || !userId || !amount) {
      return res.status(400).json({ error: "กรุณาระบุ environmentId, userId และ amount" });
    }
    
    const reqAmount = parseInt(amount);
    if (reqAmount < 1) return res.status(400).json({ error: "จำนวนต้องมากกว่า 0" });

    // เช็คว่า Environment มีจริงไหม
    const [envRows]: any = await db.query("SELECT * FROM environments WHERE id = ?", [environmentId]);
    if (envRows.length === 0) return res.status(404).json({ error: "ไม่พบ Environment ID นี้" });

    // --- Algorithm หา Port ว่าง (เริ่ม 4000) ---
    // 1. ดึง Port ทั้งหมดที่มีคนจองไปแล้วออกมา (จากทุก Env เพราะใช้ Host เดียวกัน)
    const [usedPorts]: any = await db.query("SELECT port FROM project");
    const reservedSet = new Set(usedPorts.map((r: any) => r.port));

    const assignedPorts: number[] = [];
    let currentCheck = BASE_PROJECT_PORT; // เริ่ม 4000

    // 2. วนหาจนกว่าจะได้ครบตามจำนวน
    while (assignedPorts.length < reqAmount) {
        if (!reservedSet.has(currentCheck)) {
            assignedPorts.push(currentCheck);
        }
        currentCheck++;
    }

    console.log(`📌 Assigning Ports: ${assignedPorts} to User: ${userId}`);

    // --- บันทึกลง SQL (Bulk Insert) ---
    const sql = "INSERT INTO project (port, environment, user) VALUES ?";
    const values = assignedPorts.map(p => [p, environmentId, userId]);

    await db.query(sql, [values]);

    res.status(201).json({
        message: `จองสำเร็จ ${reqAmount} โปรเจกต์`,
        environmentId: environmentId,
        ports: assignedPorts, // ส่งเลข Port กลับไปให้นิสิต
        total: assignedPorts.length
    });

  } catch (error: any) {
    console.error("❌ Request Port Error:", error.message);
    res.status(500).json({ error: "จอง Port ไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 🗑️ Route: Delete Project (ลบ Container + ลบ SQL)
// ==========================================
router.delete("/projects/:id", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const projectId = req.params.id;

    // -----------------------------------------------------
    // STEP 1: ดึงข้อมูล Project และ Endpoint ID จาก SQL
    // -----------------------------------------------------
    // เราต้อง Join ตาราง environments เพื่อเอา portainer_endpoint_id มาใช้ยิง API
    const sql = `
        SELECT p.project_id, p.port, e.portainer_endpoint_id 
        FROM project p
        JOIN environments e ON p.environment = e.id
        WHERE p.project_id = ?
    `;
    const [rows]: any = await db.query(sql, [projectId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "ไม่พบ Project ID นี้ในระบบ" });
    }

    const project = rows[0];
    console.log(`🔥 Deleting Project ID: ${projectId} (Port: ${project.port})...`);

    // -----------------------------------------------------
    // STEP 2: ค้นหาและลบ Container ใน Portainer (Docker)
    // -----------------------------------------------------
    try {
        // 2.1 ดึงรายการ Container ทั้งหมดในเครื่องแม่ออกมาดู
        const containersRes = await portainerConn.get(
            `/endpoints/${project.portainer_endpoint_id}/docker/containers/json?all=1`, 
            { headers: { Authorization: authHeader } }
        );

        // 2.2 วนหา Container ที่ใช้ Port ตรงกับ Database ของเรา
        // (เช็คจาก PublicPort)
        const targetContainer = containersRes.data.find((c: any) => 
            c.Ports.some((p: any) => p.PublicPort === project.port)
        );

        if (targetContainer) {
            console.log(`🔪 Found Container ID: ${targetContainer.Id.substring(0, 12)}. Killing it...`);
            
            // 2.3 สั่งลบ Container (Force Delete)
            await portainerConn.delete(
                `/endpoints/${project.portainer_endpoint_id}/docker/containers/${targetContainer.Id}?force=true`,
                { headers: { Authorization: authHeader } }
            );
            console.log("✅ Docker Container Deleted");
        } else {
            console.log("⚠️ Container not found in Docker (Maybe already deleted manually)");
        }

    } catch (dockerError: any) {
        // ถ้า Portainer พัง หรือหาไม่เจอ เราจะปล่อยผ่านเพื่อให้ลบใน SQL ต่อได้
        console.warn("⚠️ Failed to delete container from Docker:", dockerError.message);
    }

    // -----------------------------------------------------
    // STEP 3: ลบข้อมูลใน SQL (คืน Port)
    // -----------------------------------------------------
    await db.query("DELETE FROM project WHERE project_id = ?", [projectId]);
    console.log("✅ Project deleted from SQL Database");

    res.json({ 
        message: `ลบโปรเจกต์สำเร็จ (Port ${project.port} ว่างแล้ว)`,
        deletedId: projectId
    });

  } catch (error: any) {
    console.error("❌ Delete Project Error:", error.message);
    res.status(500).json({ error: "ลบโปรเจกต์ไม่สำเร็จ", details: error.message });
  }
});


// ==========================================
// 📋 Route: Get User's Projects (ดูว่าฉันมี Port อะไรบ้าง)
// เรียก: GET /api/projects?userId=15
// ==========================================
router.get("/projects", async (req, res) => {
    try {
        // รับ userId จาก Query Params (เช่น ?userId=15)
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: "กรุณาระบุ userId (เช่น ?userId=1)" });
        }

        // Query ข้อมูลจากตาราง project และ join กับ environments เพื่อเอาชื่อ env มาแสดง
        const sql = `
            SELECT 
                p.project_id, 
                p.port, 
                e.name as environment_name,
                e.url as host_url,
                e.portainer_endpoint_id
            FROM project p
            JOIN environments e ON p.environment = e.id
            WHERE p.user = ?
            ORDER BY p.port ASC
        `;

        const [rows]: any = await db.query(sql, [userId]);
        
        // ส่งข้อมูลกลับไป
        res.json({
            userId: userId,
            total_projects: rows.length,
            projects: rows // รายการ Port ทั้งหมดของคนนี้
        });

    } catch (error: any) {
        console.error("❌ Get Projects Error:", error.message);
        res.status(500).json({ error: "ดึงข้อมูลไม่สำเร็จ", details: error.message });
    }
});