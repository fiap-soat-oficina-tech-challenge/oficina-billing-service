-- Troca do Checkout Pro pelo QR Code dinâmico do Mercado Pago.
--
-- A cobrança passa a ser uma order de QR Code (id, conteúdo EMVCo e prazo), no
-- lugar da preferência com link. As colunas antigas não têm equivalente: um
-- link de Checkout Pro não vira QR Code. No ambiente, nenhum orçamento tinha
-- cobrança quando a troca foi feita.
--
-- Tentativas recusadas deixam de ser registradas (o Mercado Pago não as avisa
-- no QR Code), então sai o status RECUSADO do pagamento. Não havia pagamentos.

-- AlterEnum
BEGIN;
CREATE TYPE "StatusPagamento_new" AS ENUM ('APROVADO', 'ESTORNADO');
ALTER TABLE "Pagamento" ALTER COLUMN "status" TYPE "StatusPagamento_new" USING ("status"::text::"StatusPagamento_new");
ALTER TYPE "StatusPagamento" RENAME TO "StatusPagamento_old";
ALTER TYPE "StatusPagamento_new" RENAME TO "StatusPagamento";
DROP TYPE "public"."StatusPagamento_old";
COMMIT;

-- AlterTable
ALTER TABLE "Orcamento" DROP COLUMN "linkExpiraEm",
DROP COLUMN "linkPagamento",
DROP COLUMN "preferenciaId",
ADD COLUMN     "cobrancaExpiraEm" TIMESTAMP(3),
ADD COLUMN     "cobrancaId" TEXT,
ADD COLUMN     "qrCode" TEXT;

