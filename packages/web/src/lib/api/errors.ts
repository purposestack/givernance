export class ApiProblem extends Error {
  constructor(public status: number, public title: string, public detail?: string) {
    super(title);
  }
}
