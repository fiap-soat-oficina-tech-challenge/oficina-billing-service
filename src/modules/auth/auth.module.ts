import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './interface/strategies/jwt.strategy';

/**
 * Este serviço não emite token: só valida o JWT emitido pelo OS Service
 * (funcionário) ou pela Lambda de autenticação por CPF (cliente), com o mesmo
 * segredo JWT_SECRET guardado no SSM.
 */
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
})
export class AuthModule {}
