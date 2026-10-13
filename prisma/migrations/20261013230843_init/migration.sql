-- CreateEnum
CREATE TYPE "StatusOrcamento" AS ENUM ('AGUARDANDO_APROVACAO', 'APROVADO', 'RECUSADO', 'PAGO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "OrigemDecisao" AS ENUM ('CLIENTE', 'SISTEMA_EXTERNO');

-- CreateEnum
CREATE TYPE "TipoLinhaOrcamento" AS ENUM ('SERVICO', 'ITEM');

-- CreateEnum
CREATE TYPE "StatusPagamento" AS ENUM ('APROVADO', 'RECUSADO', 'ESTORNADO');

-- CreateTable
CREATE TABLE "Orcamento" (
    "id" UUID NOT NULL,
    "osId" TEXT NOT NULL,
    "codigoOS" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "clienteNome" TEXT NOT NULL,
    "clienteEmail" TEXT,
    "valorServicos" DECIMAL(10,2) NOT NULL,
    "valorPecas" DECIMAL(10,2) NOT NULL,
    "valorTotal" DECIMAL(10,2) NOT NULL,
    "status" "StatusOrcamento" NOT NULL,
    "origemDecisao" "OrigemDecisao",
    "motivoRecusa" TEXT,
    "motivoCancelamento" TEXT,
    "preferenciaId" TEXT,
    "linkPagamento" TEXT,
    "linkExpiraEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    "decididoEm" TIMESTAMP(3),
    "pagoEm" TIMESTAMP(3),
    "canceladoEm" TIMESTAMP(3),

    CONSTRAINT "Orcamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinhaOrcamento" (
    "id" UUID NOT NULL,
    "orcamentoId" UUID NOT NULL,
    "tipo" "TipoLinhaOrcamento" NOT NULL,
    "referenciaId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "precoUnitario" DECIMAL(10,2) NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "posicao" INTEGER NOT NULL,

    CONSTRAINT "LinhaOrcamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pagamento" (
    "id" TEXT NOT NULL,
    "orcamentoId" UUID NOT NULL,
    "osId" TEXT NOT NULL,
    "status" "StatusPagamento" NOT NULL,
    "valor" DECIMAL(10,2) NOT NULL,
    "detalhe" TEXT,
    "registradoEm" TIMESTAMP(3) NOT NULL,
    "pagoEm" TIMESTAMP(3),
    "estornadoEm" TIMESTAMP(3),
    "motivoEstorno" TEXT,

    CONSTRAINT "Pagamento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Orcamento_osId_key" ON "Orcamento"("osId");

-- CreateIndex
CREATE UNIQUE INDEX "Orcamento_codigoOS_key" ON "Orcamento"("codigoOS");

-- CreateIndex
CREATE INDEX "Orcamento_clienteId_idx" ON "Orcamento"("clienteId");

-- CreateIndex
CREATE INDEX "LinhaOrcamento_orcamentoId_idx" ON "LinhaOrcamento"("orcamentoId");

-- CreateIndex
CREATE INDEX "Pagamento_osId_idx" ON "Pagamento"("osId");

-- CreateIndex
CREATE INDEX "Pagamento_orcamentoId_idx" ON "Pagamento"("orcamentoId");

-- AddForeignKey
ALTER TABLE "LinhaOrcamento" ADD CONSTRAINT "LinhaOrcamento_orcamentoId_fkey" FOREIGN KEY ("orcamentoId") REFERENCES "Orcamento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pagamento" ADD CONSTRAINT "Pagamento_orcamentoId_fkey" FOREIGN KEY ("orcamentoId") REFERENCES "Orcamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
