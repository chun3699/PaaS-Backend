FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

# 1. ติดตั้ง dependencies ปกติ
# 2. แถมติดตั้ง ts-node และ typescript เข้าไปใน node_modules ด้วย (กันเหนียว)
RUN npm install && npm install ts-node typescript --save-dev

COPY . .

EXPOSE 3000

# ✅ แก้คำสั่งรัน: เรียกตัวรันจากโฟลเดอร์ node_modules โดยตรง (ชัวร์ที่สุด)
CMD ["./node_modules/.bin/ts-node", "server.ts"]