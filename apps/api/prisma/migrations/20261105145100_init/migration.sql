-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "longUrl" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "tags" TEXT,
    CONSTRAINT "Link_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClickEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clickedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "referrer" TEXT,
    "ipHash" TEXT,
    CONSTRAINT "ClickEvent_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "Link" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClickEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Link_code_key" ON "Link"("code");

-- CreateIndex
CREATE INDEX "Link_tenantId_createdAt_idx" ON "Link"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ClickEvent_tenantId_clickedAt_idx" ON "ClickEvent"("tenantId", "clickedAt" DESC);

-- CreateIndex
CREATE INDEX "ClickEvent_linkId_clickedAt_idx" ON "ClickEvent"("linkId", "clickedAt" DESC);
