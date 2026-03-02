import express from "express";
import { portainerConn, HOST_IP } from "../connection";
import { db } from "../db";
import FormData from "form-data";
import axios from "axios";

export const router = express.Router();

// ==========================================
// 🛠️ ฟังก์ชันช่วย: ดึง Token จาก Cookie
// ==========================================
const getAuthHeader = (req: express.Request) => {
  const token = (req as any).cookies?.portainer_token; 
  if (!token) {
    throw new Error("UNAUTHORIZED"); 
  }
  return `Bearer ${token}`;
};

// ==========================================
// 🔑 Route: LOGIN (POST) - เช็คสิทธิ์ Admin ตั้งแต่หน้าประตู
// ==========================================
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "กรุณาระบุ username และ password" });
    }

    // 1. ยิงไปขอ Token จาก Portainer
    const response = await portainerConn.post("/auth", {
      Username: username,
      Password: password
    });

    const token = response.data.jwt;

    // 🟢 2. แงะ Token มาดู Role ทันทีที่ Login สำเร็จ
    const payloadBase64 = token.split('.')[1];
    const decodedString = Buffer.from(payloadBase64, 'base64').toString('utf-8');
    const decodedPayload = JSON.parse(decodedString);

    // 🛑 3. ถ้า Role ไม่ใช่ 1 (Admin) ให้เตะออกเลย ไม่ยอมให้เข้า!
    if (decodedPayload.role !== 1) {
      console.log(`❌ User: ${username} พยายามเข้าใช้งาน แต่ไม่ใช่ Admin`);
      return res.status(403).json({ error: "คุณไม่มีสิทธิ์เข้าถึงหน้านี้ (เฉพาะแอดมินเท่านั้น)" });
    }

    console.log(`✅ Admin: ${username} Login สำเร็จ (ฝัง Cookie)`);
    
    // 4. ถ้าเป็น Admin ค่อยยอมฝัง Cookie ให้
    res.cookie('portainer_token', token, {
        httpOnly: true, 
        maxAge: 8 * 60 * 60 * 1000, 
    });

    res.json({ message: "Login successful" });

  } catch (error: any) {
    console.error("❌ Login failed:", error.message);
    res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  }
});

// ==========================================
// 🌐 Route: Get Environments (ดึงจาก SQL)
// ==========================================
router.get("/environmentsql", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM environments");
    res.json(rows);
  } catch (error: any) {
    console.error("❌ Error fetching environments:", error.message);
    res.status(500).json({ error: "ดึงข้อมูล Environment จากฐานข้อมูลไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 📦 Route: Get Containers (อัตโนมัติ)
// ==========================================
router.get("/containers/:id", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const envId = req.params.id;

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
    if (error.message === "UNAUTHORIZED" || error.response?.status === 401) {
      return res.status(401).json({ error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
    }
    if (error.response?.status === 404) {
        return res.status(404).json({ error: "ไม่พบข้อมูล Environment ID นี้ในระบบ" });
    }
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล Container", details: error.message });
  }
});

// ==========================================
// 🌐 Route: Get Environments (Portainer)
// ==========================================
router.get("/environments", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
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

    res.json(environments);

  } catch (error: any) {
     if (error.message === "UNAUTHORIZED" || error.response?.status === 401) {
      return res.status(401).json({ error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
    }
    res.status(500).json({ error: "ไม่สามารถดึงรายชื่อ Environment จาก Portainer ได้" });
  }
});

// ==========================================
// ✏️ Route: Edit Environment (เปลี่ยนชื่อ/IP)
// ==========================================
router.put("/environments/:id", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const envId = req.params.id; 
    const { name, url } = req.body;

    if (!name && !url) {
      return res.status(400).json({ error: "กรุณาระบุชื่อหรือ URL ที่ต้องการแก้ไข" });
    }

    const payload: any = {};
    if (name) payload.Name = name;
    if (url) payload.URL = url.startsWith("tcp://") ? url : `tcp://${url}`;

    const response = await portainerConn.put(`/endpoints/${envId}`, payload, {
        headers: { Authorization: authHeader }
    });

    console.log(`✅ แก้ไข Environment ID: ${envId} สำเร็จ`);
    res.json({ message: "แก้ไขข้อมูลสำเร็จ", data: response.data });

  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return res.status(401).json({ error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
    res.status(500).json({ error: "แก้ไขข้อมูลไม่สำเร็จ อาจไม่มีอยู่จริง หรือ Portainer ปฏิเสธ" });
  }
});

// ==========================================
// 🏢 Create Team
// ==========================================
router.post("/teams", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { name } = req.body;

    if (!name) return res.status(400).json({ error: "กรุณาระบุชื่อกลุ่ม/ทีม" });

    // 🛑 ดักจับ: เช็คชื่อทีมซ้ำ
    const [existingTeams]: any = await db.query("SELECT id_team FROM teams WHERE name = ?", [name]);
    if (existingTeams.length > 0) {
        return res.status(409).json({ error: `มีกลุ่มชื่อ "${name}" ในระบบอยู่แล้ว กรุณาใช้ชื่ออื่น` });
    }

    const portainerRes = await portainerConn.post("/teams", { Name: name }, { headers: { Authorization: authHeader } });
    const newTeamId = portainerRes.data.Id;
    
    await db.query("INSERT INTO teams (portainer_team_id, name) VALUES (?, ?)", [newTeamId, name]);

    res.status(201).json({ message: "สร้างกลุ่มเรียนสำเร็จ", teamId: newTeamId, name });

  } catch (error: any) {
    if (error.response?.status === 409) return res.status(409).json({ error: `มีกลุ่มชื่อนี้อยู่แล้วใน Portainer` });
    res.status(500).json({ error: "สร้างกลุ่มไม่สำเร็จ กรุณาลองใหม่", details: error.message });
  }
});

// ==========================================
// 🗑️ Route: Remove User from Team (เตะออกจากทีม)
// ==========================================
router.delete("/users/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { userId } = req.body; 

    if (!userId) return res.status(400).json({ error: "กรุณาระบุ ID นิสิตที่ต้องการนำออก" });

    try {
        const membershipsRes = await portainerConn.get(`/users/${userId}/memberships`, {
            headers: { Authorization: authHeader }
        });
        for (const membership of membershipsRes.data) {
            await portainerConn.delete(`/team_memberships/${membership.Id}`, {
                headers: { Authorization: authHeader }
            });
        }
    } catch (e: any) {}

    await db.query("UPDATE users SET portainer_team_id = NULL WHERE portainer_user_id = ?", [userId]);

    res.json({ message: "นำนิสิตออกจากทีมสำเร็จ" });

  } catch (error: any) {
    res.status(500).json({ error: "เกิดข้อผิดพลาด นำออกจากทีมไม่สำเร็จ" });
  }
});

// ==========================================
// 🗑️ Route: Delete Team (Transaction Mode)
// ==========================================
router.delete("/teams/:id", async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction(); 
    const authHeader = getAuthHeader(req);
    const teamId = req.params.id; 

    if (!teamId || teamId === 'undefined') throw new Error("ID ของทีมไม่ถูกต้อง");

    const [teamRows]: any = await connection.query("SELECT * FROM teams WHERE id_team = ?", [teamId]);
    if (teamRows.length === 0) {
        connection.release();
        return res.status(404).json({ error: "ไม่พบทีมนี้ในระบบ อาจถูกลบไปแล้ว" });
    }
    
    const team = teamRows[0];
    const portainerTeamId = team.portainer_team_id;

    if (portainerTeamId) {
        try {
            await portainerConn.delete(`/teams/${portainerTeamId}`, { headers: { Authorization: authHeader } });
        } catch (e: any) {}

        await connection.query("UPDATE users SET portainer_team_id = NULL WHERE portainer_team_id = ?", [portainerTeamId]);
        await connection.query("UPDATE environments SET portainer_team_id = NULL WHERE portainer_team_id = ?", [portainerTeamId]);
    }

    await connection.query("DELETE FROM teams WHERE id_team = ?", [teamId]);
    await connection.commit(); 
    res.json({ message: `ลบกลุ่ม ${team.name} สำเร็จ` });

  } catch (error: any) {
    await connection.rollback(); 
    res.status(500).json({ error: "ลบกลุ่มไม่สำเร็จ: " + error.message });
  } finally {
    connection.release(); 
  }
});

// ==========================================
// 👤 Create User 
// ==========================================
router.post("/users", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { username, password, teamId } = req.body;

    if (!username || !password) return res.status(400).json({ error: "กรุณากรอก Username และ Password" });

    // 🛑 ดักจับ: เช็คชื่อผู้ใช้ซ้ำ
    const [existingUsers]: any = await db.query("SELECT id_users FROM users WHERE username = ?", [username]);
    if (existingUsers.length > 0) {
        return res.status(409).json({ error: `มีชื่อผู้ใช้ "${username}" อยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น` });
    }

    if (teamId) {
        const [rows]: any = await db.query("SELECT id_team FROM teams WHERE portainer_team_id = ?", [teamId]);
        if (rows.length === 0) return res.status(400).json({ error: `ไม่พบกลุ่มที่เลือกในระบบ` });
    }

    const roleId = 2; 
    const userRes = await portainerConn.post("/users", { 
        Username: username, Password: password, Role: roleId 
    }, { headers: { Authorization: authHeader } });
    
    const newUserId = userRes.data.Id;

    if (teamId) {
      try {
        await portainerConn.post("/team_memberships", {
          UserID: newUserId, TeamID: teamId, Role: 2 
        }, { headers: { Authorization: authHeader } });
      } catch (e: any) {}
    }

    try {
      const sql = "INSERT INTO users (portainer_user_id, username, password, role, portainer_team_id) VALUES (?, ?, ?, ?, ?)";
      await db.query(sql, [newUserId, username, password, roleId, teamId || null]);
    } catch (sqlError: any) {
      return res.status(500).json({ error: "บันทึกข้อมูลลงฐานข้อมูลไม่สำเร็จ", details: sqlError.message });
    }

    res.status(201).json({ message: "สร้างผู้ใช้สำเร็จ", userId: newUserId });

  } catch (error: any) {
    if (error.response?.status === 409) return res.status(409).json({ error: `ชื่อผู้ใช้นี้ถูกใช้ไปแล้วใน Portainer` });
    res.status(500).json({ error: "สร้างผู้ใช้ไม่สำเร็จ", details: error.message });
  }
});

// ==========================================
// 🗑️ Delete User (Full Clean)
// ==========================================
router.delete("/users/:id", async (req, res) => {
    const localUserId = req.params.id;

    try {
        const [rows]: any = await db.query("SELECT * FROM users WHERE id_users = ?", [localUserId]);
        if (rows.length === 0) return res.status(404).json({ error: "ไม่พบข้อมูลผู้ใช้นี้ อาจถูกลบไปแล้ว" });

        const targetUser = rows[0];
        const portainerUserId = targetUser.portainer_user_id;

        // ลบ Database ส่วนตัวของนิสิต
        if (targetUser.mysql === 1) {
            try {
                const safeUsername = targetUser.username.replace(/[^a-zA-Z0-9_]/g, "");
                const dbName = `db_${safeUsername}`;
                const dbUser = safeUsername;

                await db.query(`DROP DATABASE IF EXISTS ??`, [dbName]);
                await db.query(`DROP USER IF EXISTS '${dbUser}'@'%'`);
            } catch (sqlErr: any) {}
        }

        // ลบ Portainer User
        if (portainerUserId) {
            try {
                const authHeader = getAuthHeader(req); 
                await portainerConn.delete(`/users/${portainerUserId}`, {
                    headers: { Authorization: authHeader }
                });
            } catch (err: any) {}
        }

        // ลบแถวใน SQL
        const [result]: any = await db.query("DELETE FROM users WHERE id_users = ?", [localUserId]);
        if (result.affectedRows === 0) return res.status(500).json({ error: "ลบข้อมูลใน SQL ไม่สำเร็จ" });

        res.status(200).json({ message: "ลบผู้ใช้และข้อมูลทั้งหมดสำเร็จ", deletedId: localUserId });

    } catch (error: any) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการลบผู้ใช้" });
    }
});

// ==========================================
// 📋 Route: Get All Teams 
// ==========================================
router.get("/teams", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM teams");
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: "ดึงข้อมูลกลุ่มเรียนไม่สำเร็จ" });
  }
});

// ==========================================
// 👥 Route: Get All Users
// ==========================================
router.get("/users", async (req, res) => {
  try {
    const sql = `
      SELECT 
        users.id_users, 
        users.portainer_user_id,
        users.username,
        users.role,
        users.portainer_team_id,
        users.mysql, 
        teams.name AS team_name
      FROM users
      LEFT JOIN teams ON users.portainer_team_id = teams.portainer_team_id
    `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: "ดึงข้อมูลผู้ใช้ไม่สำเร็จ" });
  }
});

// ==========================================
// 🔄 Route: Change Team
// ==========================================
router.put("/users/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const { userId, teamId } = req.body;

    if (!userId || !teamId) return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน กรุณาระบุให้ครบ" });

    const [teams]: any = await db.query("SELECT * FROM teams WHERE portainer_team_id = ?", [teamId]);
    if (teams.length === 0) return res.status(404).json({ error: `ไม่พบกลุ่มปลายทางในระบบ` });

    const membershipsRes = await portainerConn.get(`/users/${userId}/memberships`, { headers: { Authorization: authHeader } });
    for (const membership of membershipsRes.data) {
      await portainerConn.delete(`/team_memberships/${membership.Id}`, { headers: { Authorization: authHeader } });
    }

    await portainerConn.post("/team_memberships", { UserID: userId, TeamID: teamId, Role: 2 }, { headers: { Authorization: authHeader } });
    await db.query("UPDATE users SET portainer_team_id = ? WHERE portainer_user_id = ?", [teamId, userId]);

    res.json({ message: "ย้ายกลุ่มสำเร็จ" });

  } catch (error: any) {
    res.status(500).json({ error: "ไม่สามารถย้ายกลุ่มได้ กรุณาลองใหม่" });
  }
});

// ==========================================
// 1. สร้าง Environment 
// ==========================================
router.post("/environments", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    let { name } = req.body; 

    if (!name) return res.status(400).json({ error: "กรุณาระบุชื่อ Environment" });
    name = name.trim();

    // 🛑 ดักจับ: เช็คชื่อซ้ำ
    const [existingEnvs]: any = await db.query("SELECT id FROM environments WHERE name = ?", [name]);
    if (existingEnvs.length > 0) return res.status(409).json({ error: `ชื่อ "${name}" ถูกใช้งานแล้ว กรุณาตั้งชื่ออื่น` });

    const form = new FormData();
    form.append('Name', name);                   
    form.append('URL', 'unix:///var/run/docker.sock'); 
    form.append('EndpointCreationType', '1');   
    form.append('TLS', 'false');                

    const length = await new Promise<number>((resolve, reject) => {
        form.getLength((err, len) => { if (err) reject(err); else resolve(len); });
    });

    const createRes = await portainerConn.post('/endpoints', form, {
      headers: { 
          'Authorization': authHeader,
          'Content-Type': form.getHeaders()['content-type'], 
          'Content-Length': length
      }
    });

    await db.query("INSERT INTO environments (portainer_endpoint_id, name, url, portainer_team_id) VALUES (?, ?, ?, NULL)", 
                   [createRes.data.Id, name, 'unix:///var/run/docker.sock']);

    res.status(201).json({ message: "สร้าง Environment สำเร็จ", endpointId: createRes.data.Id });

  } catch (error: any) {
    if (error.response?.status === 409) return res.status(409).json({ error: "Portainer แจ้งว่าชื่อนี้มีอยู่แล้ว" });
    res.status(500).json({ error: "สร้าง Environment ไม่สำเร็จ กรุณาตรวจสอบ Portainer" });
  }
});

// ==========================================
// 3. ลบ Environment
// ==========================================
router.delete("/environments/:id", async (req, res) => {
  const connection = await db.getConnection(); 
  try {
    await connection.beginTransaction(); 
    const authHeader = getAuthHeader(req);
    const id = req.params.id;

    const [rows]: any = await connection.query("SELECT * FROM environments WHERE id = ?", [id]);
    if (rows.length === 0) {
        connection.release();
        return res.status(404).json({ error: "ไม่พบ Environment ในระบบ อาจถูกลบไปแล้ว" });
    }

    const portainerId = rows[0].portainer_endpoint_id;

    try {
        const stacksRes = await portainerConn.get(`/stacks?filters={"EndpointID":${portainerId}}`, { headers: { Authorization: authHeader } });
        const protectedStacks = ["my-paas-project", "production-mysql", "portainer"];
        for (const stack of stacksRes.data) {
            if (!protectedStacks.includes(stack.Name)) {
                await portainerConn.delete(`/stacks/${stack.Id}?endpointId=${portainerId}`, { headers: { Authorization: authHeader } });
            }
        }
    } catch (err: any) {}

    try {
        await portainerConn.delete(`/endpoints/${portainerId}`, { headers: { Authorization: authHeader } });
    } catch (err: any) {}

    try {
        await connection.query("DELETE FROM project WHERE environment = ?", [id]);
    } catch (e: any) { throw e; }

    await connection.query("DELETE FROM environments WHERE id = ?", [id]);
    await connection.commit(); 
    res.json({ message: "ลบ Environment และเคลียร์พื้นที่เรียบร้อย" });

  } catch (error: any) {
    await connection.rollback(); 
    res.status(500).json({ error: "ไม่สามารถลบ Environment ได้", details: error.message });
  } finally {
    connection.release();
  }
});

// ==========================================
// 🔄 Route: Assign/Update Team
// ==========================================
router.put("/environments/:id/team", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const envId = req.params.id;      
    const { teamId } = req.body;      

    const [envRows]: any = await db.query("SELECT * FROM environments WHERE id = ?", [envId]);
    if (envRows.length === 0) return res.status(404).json({ error: "ไม่พบ Environment ในระบบ" });
    const targetEnv = envRows[0];

    if (teamId) {
        const [teamRows]: any = await db.query("SELECT * FROM teams WHERE portainer_team_id = ?", [teamId]);
        if (teamRows.length === 0) return res.status(404).json({ error: `ไม่พบกลุ่มเป้าหมายในระบบ` });

        const [oldEnvs]: any = await db.query("SELECT * FROM environments WHERE portainer_team_id = ? AND id != ?", [teamId, envId]);
        if (oldEnvs.length > 0) {
            for (const oldEnv of oldEnvs) {
                try {
                    await portainerConn.put(`/endpoints/${oldEnv.portainer_endpoint_id}`, { TeamAccessPolicies: {} }, { headers: { Authorization: authHeader } });
                } catch (e: any) {}
                await db.query("UPDATE environments SET portainer_team_id = NULL WHERE id = ?", [oldEnv.id]);
            }
        }
    }

    const accessPayload = { TeamAccessPolicies: teamId ? { [`${teamId}`]: { RoleId: 0 } } : {} };
    
    try {
        await portainerConn.put(`/endpoints/${targetEnv.portainer_endpoint_id}`, accessPayload, { headers: { Authorization: authHeader } });
    } catch (err: any) {
        return res.status(500).json({ error: "อัปเดตสิทธิ์ใน Portainer ไม่สำเร็จ" });
    }

    await db.query("UPDATE environments SET portainer_team_id = ? WHERE id = ?", [teamId || null, envId]);
    res.json({ message: "ผูกกลุ่มเข้ากับ Environment สำเร็จ" });

  } catch (error: any) {
    res.status(500).json({ error: "ไม่สามารถผูกกลุ่มได้ เกิดข้อผิดพลาดในระบบ" });
  }
});

const BASE_PROJECT_PORT = 4000; 

// ==========================================
// 2. ขอ Port/Project
// ==========================================
router.post("/projects", async (req, res) => {
  try {
    const { environmentId, userId, amount } = req.body;

    if (!environmentId || !userId || !amount) {
      return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน กรุณาเลือกสภาพแวดล้อม ผู้ใช้ และจำนวน" });
    }
    
    const reqAmount = parseInt(amount);
    if (reqAmount < 1) return res.status(400).json({ error: "จำนวน Port ต้องเป็นตัวเลขมากกว่า 0" });

    const [envRows]: any = await db.query("SELECT * FROM environments WHERE id = ?", [environmentId]);
    if (envRows.length === 0) return res.status(404).json({ error: "ไม่พบ Environment ที่ต้องการผูก" });

    const [usedPorts]: any = await db.query("SELECT port FROM project");
    const reservedSet = new Set(usedPorts.map((r: any) => r.port));

    const assignedPorts: number[] = [];
    let currentCheck = BASE_PROJECT_PORT; 

    while (assignedPorts.length < reqAmount) {
        if (!reservedSet.has(currentCheck)) assignedPorts.push(currentCheck);
        currentCheck++;
    }

    const sql = "INSERT INTO project (port, environment, user) VALUES ?";
    const values = assignedPorts.map(p => [p, environmentId, userId]);
    await db.query(sql, [values]);

    res.status(201).json({ message: `จองสำเร็จ ${reqAmount} โปรเจกต์`, ports: assignedPorts });

  } catch (error: any) {
    res.status(500).json({ error: "จอง Port ไม่สำเร็จ ระบบขัดข้อง" });
  }
});

// ==========================================
// 🗑️ Route: Delete Project
// ==========================================
router.delete("/projects/:id", async (req, res) => {
  try {
    const authHeader = getAuthHeader(req);
    const projectId = req.params.id;

    const sql = `SELECT p.project_id, p.port, e.portainer_endpoint_id 
                 FROM project p JOIN environments e ON p.environment = e.id WHERE p.project_id = ?`;
    const [rows]: any = await db.query(sql, [projectId]);

    if (rows.length === 0) return res.status(404).json({ error: "ไม่พบข้อมูลโปรเจกต์นี้ อาจถูกลบไปแล้ว" });
    const project = rows[0];

    try {
        const containersRes = await portainerConn.get(`/endpoints/${project.portainer_endpoint_id}/docker/containers/json?all=1`, { headers: { Authorization: authHeader } });
        const targetContainer = containersRes.data.find((c: any) => c.Ports.some((p: any) => p.PublicPort === project.port));
        if (targetContainer) {
            await portainerConn.delete(`/endpoints/${project.portainer_endpoint_id}/docker/containers/${targetContainer.Id}?force=true`, { headers: { Authorization: authHeader } });
        }
    } catch (dockerError: any) {}

    await db.query("DELETE FROM project WHERE project_id = ?", [projectId]);
    res.json({ message: `คืนค่า Port ${project.port} เข้าสู่ระบบสำเร็จ` });

  } catch (error: any) {
    res.status(500).json({ error: "ลบโปรเจกต์และคืนค่า Port ไม่สำเร็จ" });
  }
});

// ==========================================
// 📋 Route: Get User's Projects
// ==========================================
router.get("/projects", async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: "กรุณาระบุ ID ของนิสิตที่ต้องการดูข้อมูล" });

        const sql = `
            SELECT p.project_id, p.port, e.name as environment_name, e.url as host_url, e.portainer_endpoint_id
            FROM project p JOIN environments e ON p.environment = e.id WHERE p.user = ? ORDER BY p.port ASC
        `;
        const [rows]: any = await db.query(sql, [userId]);
        
        res.json({ userId: userId, total_projects: rows.length, projects: rows });

    } catch (error: any) {
        res.status(500).json({ error: "ไม่สามารถดึงข้อมูลพอร์ตของนิสิตได้" });
    }
});