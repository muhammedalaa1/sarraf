import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule, { rawBody: true });
await app.listen(Number(process.env.PORT ?? 3001));
console.log(`Sarraf NestJS shop on ${await app.getUrl()}`);
