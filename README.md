# Sistema Packing House — etapa 2

Sistema web com banco SQLite, autenticação por JWT, senha com hash bcrypt e níveis de acesso.

## Perfis
- admin: acesso total
- gerente: gestão e exclusão de lançamentos
- supervisor: cadastro de embaladoras e lançamentos
- cq: lançamentos de produção
- embaladora: lançamentos de produção

## Instalação
1. Instale Node.js 18+.
2. Abra o terminal nesta pasta.
3. Execute `npm install`.
4. Execute `npm start`.
5. Acesse `http://localhost:3000`.

Acesso inicial: admin / admin123. Troque a senha antes de uso real.

O banco `packing.db` é criado automaticamente na primeira execução.
