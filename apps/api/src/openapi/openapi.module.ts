import { Controller, Get, Module } from '@nestjs/common';
import { buildOpenApiDocument } from './document.js';

/** Staff-only (behind the auth guard): the spec maps the attack surface, so it is not public. */
@Controller()
class OpenApiController {
  private readonly doc = buildOpenApiDocument();

  @Get('openapi.json')
  spec() {
    return this.doc;
  }
}

@Module({ controllers: [OpenApiController] })
export class OpenApiModule {}
