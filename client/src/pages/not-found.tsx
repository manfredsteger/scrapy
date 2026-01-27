import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md mx-auto shadow-xl border-border/50">
        <CardContent className="pt-6 pb-8 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-6 text-destructive">
            <AlertCircle className="w-8 h-8" />
          </div>
          
          <h1 className="text-3xl font-bold text-foreground mb-2 font-display">404 Page Not Found</h1>
          <p className="text-muted-foreground mb-8 text-balance">
            The page you are looking for doesn't exist or has been moved.
          </p>

          <Link href="/">
            <Button className="w-full sm:w-auto min-w-[140px]" size="lg">
              Return Home
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
